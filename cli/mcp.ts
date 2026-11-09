// `agent-autoloop mcp`: the hub's doors as MCP tools over stdio, using the keys already in this machine's config.json.
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { versionName } from "../host/version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "查看现在的事项和卡片", {}, []],
  ["why", "查看一轮的事件、规则和结果", { run: positive }, ["run"]],
  [
    "answer",
    "回答卡片；选项从 0 开始，也可以写自己的答案",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  ["resolve", "将卡片结案，写明已核实的结果", { card: positive, reason: string }, ["card", "reason"]],
  ["stop", "停止一轮", { run: positive }, ["run"]],
  ["retry", "把停掉的一轮重新排队，保留原来的事件和会话", { run: positive }, ["run"]],
  [
    "emit",
    "用本机来源发送事件；相同编号只记一次",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  ["tell", "用本机来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
  ["pause", "暂停一条规则：到点不跑、来事件不接", { rule: string, reason: string, until: string }, ["rule"]],
  ["resume", "恢复一条暂停的规则", { rule: string }, ["rule"]],
  ["run", "立即运行一条规则一轮", { rule: string, subject: string, reason: string }, ["rule"]],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
  return specs
    .filter(([name]) => (usesSourceKey(name) ? config.source : config.owner))
    .map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      annotations: {
        readOnlyHint: ["status", "why"].includes(name),
        destructiveHint: name === "stop" || name === "retry",
      },
    }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "status":
      return hub.state();
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "retry":
      return hub.retry(args.run);
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
    case "pause":
      return hub.pause(args.rule, {
        ...(args.reason !== undefined && { reason: args.reason }),
        ...(args.until !== undefined && { until: args.until }),
      });
    case "resume":
      return hub.resume(args.rule);
    case "run":
      return hub.run(args.rule, {
        ...(args.subject !== undefined && { subject: args.subject }),
        ...(args.reason !== undefined && { reason: args.reason }),
      });
  }
}

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return refuse(id, -32602, "工具名或参数不正确");
    const hub = hubClient(config.url, usesSourceKey(tool.name) ? config.source!.key : config.owner!);
    try {
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  eachLine(process.stdin, (line) => {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      return refuse(null, -32700, "不是 JSON");
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return refuse(request?.id ?? null, -32600, "请求格式不正确");
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    if (method === "initialize") {
      const serverInfo = { name: "agent-autoloop", version: versionName() };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (method === "tools/list") reply(id, { result: { tools } });
    // Each answers by itself, however long it takes: a client's ping has to get through meanwhile.
    else if (method === "tools/call") void answerCall(id, params);
    else refuse(id, -32601, "没有这个方法");
  });
}

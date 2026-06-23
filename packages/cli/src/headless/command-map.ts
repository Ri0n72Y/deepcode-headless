import { BUILTIN_SLASH_COMMANDS, type SlashCommandItem } from "../ui/core/slash-commands";

export type HeadlessCommandRoute = {
  name: string;
  label: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  aliases: string[];
  implemented: boolean;
};

const READ_ONLY_COMMANDS = new Set(["skills", "resume", "mcp", "model"]);
const IMPLEMENTED_COMMANDS = new Set(["skills", "new", "init", "resume", "continue", "undo", "mcp", "model", "exit"]);

function commandMethod(command: SlashCommandItem): "GET" | "POST" {
  return READ_ONLY_COMMANDS.has(command.name) ? "GET" : "POST";
}

function commandAliases(command: SlashCommandItem): string[] {
  if (command.name === "model") {
    return ["/model"];
  }
  return [`/${command.name}`, `/api/${command.name}`];
}

export function buildHeadlessCommandRoutes(): HeadlessCommandRoute[] {
  return BUILTIN_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    label: command.label,
    description: command.description,
    method: commandMethod(command),
    path: `/${command.name}`,
    aliases: commandAliases(command),
    implemented: IMPLEMENTED_COMMANDS.has(command.name),
  }));
}

export function findHeadlessCommandRoute(pathname: string): HeadlessCommandRoute | null {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  return buildHeadlessCommandRoutes().find((route) => route.aliases.includes(normalized)) ?? null;
}

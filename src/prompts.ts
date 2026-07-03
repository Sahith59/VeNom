// Zero-dependency interactive prompts built on node:readline.
import * as readline from "node:readline";
import { bold, cyan, dim } from "./style.js";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function text(label: string, def = ""): Promise<string> {
  const suffix = def ? dim(` (${def})`) : "";
  const answer = (await ask(`${cyan("?")} ${bold(label)}${suffix}: `)).trim();
  return answer || def;
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export async function select(label: string, options: Option[], defaultIndex = 0): Promise<string> {
  if (options.length === 0) throw new Error("select() needs at least one option");
  const fallback = options[defaultIndex] ?? options[0]!;
  console.log(`\n${cyan("?")} ${bold(label)}`);
  options.forEach((o, i) => {
    const marker = i === defaultIndex ? cyan("›") : " ";
    console.log(`  ${marker} ${i + 1}. ${o.label}${o.hint ? dim(`  — ${o.hint}`) : ""}`);
  });
  const raw = (await ask(dim(`  Enter number [${defaultIndex + 1}]: `))).trim();
  if (!raw) return fallback.value;
  const n = Number.parseInt(raw, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) {
    const chosen = options[n - 1];
    if (chosen) return chosen.value;
  }
  console.log(dim("  (not a valid choice — using the default)"));
  return fallback.value;
}

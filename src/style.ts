// Zero-dependency ANSI styling. Respects NO_COLOR and non-TTY output.
const on = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string): string => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const cyan = wrap("36");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");

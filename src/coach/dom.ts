// Tiny DOM helpers shared by the coach UI modules.
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const el = (tag: string, props: Record<string, string> = {}, text?: string) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

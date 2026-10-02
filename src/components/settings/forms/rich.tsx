// Renders a translated template whose {name} placeholders are React nodes
// (inline <code>/<strong>/<a>), so word order stays with the translation.
// Same shape as the helper in discord-link-ui.tsx.
export function rich(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? <span key={i}>{nodes[m[1]]}</span> : part;
  });
}

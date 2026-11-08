// Renders a translated template whose {name} placeholders are React nodes
// (inline <code>/<strong>/<a>), so word order stays with the translation. The
// one copy every client view shares. Only the caller's OWN keys count: a
// `{constructor}` in a template stays text instead of matching Object's.
export function rich(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && Object.hasOwn(nodes, m[1]) ? <span key={i}>{nodes[m[1]]}</span> : part;
  });
}

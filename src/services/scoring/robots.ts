// robots.txt rules (RFC 9309), just enough to answer "may crawler X fetch path Y?".
// Pure: works on the robots.txt text already collected in website_data.

export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export function parseRobots(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow allows everything: it isn't a rule.
      if (value) current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether `agent` may fetch `path`. Uses the groups naming the agent (merged), else the `*` groups;
 * the longest matching rule wins and Allow wins a tie. No matching group or rule = allowed.
 */
export function isAllowed(groups: RobotsGroup[], agent: string, path = "/"): boolean {
  const name = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(name));
  const applicable = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; path: string } | null = null;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

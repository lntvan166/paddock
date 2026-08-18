import { useEffect, useState } from "react";
import { agentIdFromHash } from "@shared/route";

export { agentHash, agentIdFromHash } from "@shared/route";

export function useAgentRoute(): string | null {
  const [id, setId] = useState(() => agentIdFromHash(location.hash));
  useEffect(() => {
    const onChange = () => setId(agentIdFromHash(location.hash));
    addEventListener("hashchange", onChange);
    // Re-read on mount as well: the hash can change between the initial
    // useState and the listener being attached.
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return id;
}

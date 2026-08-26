import { useEffect, useState } from "react";
import { agentIdFromHash, spaceIdFromHash } from "@shared/route";

export { agentHash, agentIdFromHash, spaceHash, spaceIdFromHash } from "@shared/route";

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

export function useSettingsRoute(): boolean {
  const [on, setOn] = useState(() => location.hash === "#/settings");
  useEffect(() => {
    const onChange = () => setOn(location.hash === "#/settings");
    addEventListener("hashchange", onChange);
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return on;
}

export function useSpacesRoute(): boolean {
  const [on, setOn] = useState(() => location.hash === "#/spaces");
  useEffect(() => {
    const onChange = () => setOn(location.hash === "#/spaces");
    addEventListener("hashchange", onChange);
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return on;
}

/**
 * The space this hash addresses, or null.
 *
 * Returns the ID rather than a boolean, unlike `useSpacesRoute` beside it: the
 * screen needs to know WHICH space, and a boolean plus a second read of
 * `location.hash` would be two sources for one fact.
 */
export function useSpaceRoute(): string | null {
  const [id, setId] = useState(() => spaceIdFromHash(location.hash));
  useEffect(() => {
    const onChange = () => setId(spaceIdFromHash(location.hash));
    addEventListener("hashchange", onChange);
    // Re-read on mount as well, for the reason `useAgentRoute` gives: the hash
    // can change between the initial useState and the listener attaching.
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return id;
}

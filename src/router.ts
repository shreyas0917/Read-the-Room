import { useEffect, useState } from "react";

// Two routes don't justify a router dependency: "/" and "/r/:code".

export function navigate(path: string): void {
  if (location.pathname !== path) history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

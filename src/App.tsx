import { usePath } from "./router";
import { Landing } from "./screens/Landing";
import { RoomScreen } from "./screens/RoomScreen";
import { CODE_RE } from "./lib/api";

export function App() {
  const path = usePath();
  const m = /^\/r\/([A-Za-z]{4})\/?$/.exec(path);
  const code = m?.[1]?.toUpperCase();
  if (code && CODE_RE.test(code)) return <RoomScreen key={code} code={code} />;
  return <Landing />;
}

import { useUiStore } from "../store/uiStore";
import { Spinner } from "./Spinner";

export function BusySpinner() {
  const busy = useUiStore((state) => state.busyCount > 0);
  if (!busy) return null;
  return <Spinner label="Working" />;
}

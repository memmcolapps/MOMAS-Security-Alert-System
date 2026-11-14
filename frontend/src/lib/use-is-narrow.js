import { useEffect, useState } from "react";

// Phone-sized screens (below Tailwind's md breakpoint) get bottom sheets and a
// full-screen call; anything wider keeps the map in view.
const QUERY = "(max-width: 767px)";

export function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return undefined;
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return Boolean(narrow);
}

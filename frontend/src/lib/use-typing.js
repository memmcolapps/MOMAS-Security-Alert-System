import { useEffect, useState } from "react";

const NOT_TEXT = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"]);

function isTextField(node) {
  if (!node) return false;
  if (node.isContentEditable || node.tagName === "TEXTAREA" || node.tagName === "SELECT") return true;
  return node.tagName === "INPUT" && !NOT_TEXT.has(String(node.type).toLowerCase());
}

/**
 * True while a text field has focus. On a phone that is when the keyboard is
 * up and the screen is at its smallest, so floating panels should step aside.
 */
export function useTyping() {
  const [typing, setTyping] = useState(() => isTextField(typeof document !== "undefined" ? document.activeElement : null));
  useEffect(() => {
    const update = () => setTyping(isTextField(document.activeElement));
    // focusout fires before the next field takes focus; wait a tick so moving
    // between two fields does not flash the panels back.
    const onOut = () => setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return typing;
}

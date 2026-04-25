const trimSlash = (value) => String(value || "").replace(/\/+$/, "");

export const config = {
  apiBase: trimSlash(
    import.meta.env.VITE_MOMAS_API_BASE ||
      window.MOMAS_CONFIG?.apiBase ||
      "http://localhost:5050",
  ),
  refreshMs: Number(
    import.meta.env.VITE_MOMAS_REFRESH_MS ||
      window.MOMAS_CONFIG?.refreshMs ||
      300000,
  ),
  maxMarkers: Number(
    import.meta.env.VITE_MOMAS_MAX_MARKERS ||
      window.MOMAS_CONFIG?.maxMarkers ||
      500,
  ),
};

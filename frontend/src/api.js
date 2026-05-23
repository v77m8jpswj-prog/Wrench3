import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

const TOKEN_KEY = "dw_token";

export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

const client = axios.create({ baseURL: API });
client.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

// Swallow background/transient errors at the response level so they don't bubble
// up as unhandled rejections to React's dev error overlay (the scary red wall).
// Functional callers can still .catch() on their own — this only kills the OVERLAY
// trigger on the global rejection handler.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    // Suppress axios "Network Error" and 4xx/5xx noise from transient polling
    if (r && (r.isAxiosError || r.message === "Network Error" || (r.response && r.response.status))) {
      e.preventDefault();
      // eslint-disable-next-line no-console
      console.warn("[suppressed]", r.message, r.config?.url || "");
    }
  });
}

export default client;

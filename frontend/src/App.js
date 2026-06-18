import React, { useState, useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, Link, useLocation } from "react-router-dom";
import "@/App.css";
import api, { setToken, getToken, clearToken } from "@/api";
import { AppProvider } from "@/AppContext";
import Login from "@/pages/Login";
import Chat from "@/pages/Chat";
import Home from "@/pages/Home";
import Call from "@/pages/Call";
import Charts from "@/pages/Charts";
import Library from "@/pages/Library";
import Vehicles from "@/pages/Vehicles";
import Datalog from "@/pages/Datalog";
import Memory from "@/pages/Memory";
import Vault from "@/pages/Vault";
import Cases from "@/pages/Cases";
import TeamChat from "@/pages/TeamChat";
import Letters from "@/pages/Letters";
import Jobs from "@/pages/Jobs";
import Email from "@/pages/Email";
import DiffTune from "@/pages/DiffTune";
import Tune from "@/pages/Tune";
import Leads from "@/pages/Leads";
import Learn from "@/pages/Learn";
// /usage page is loaded via React.lazy to dodge a minifier collision we hit
// twice with bare imports (`Usage`, `UsagePage`). Lazy-loading is dynamic so
// the bundler can't strip its import declaration.
const LlmUsageScreen = lazy(() => import("@/pages/Usage"));
import Watchlist from "@/pages/Watchlist";
import Snippets from "@/pages/Snippets";
import ShopLanding from "@/pages/ShopLanding";
import Settings from "@/pages/Settings";
import SmsInbox from "@/pages/SmsInbox";
import Inbox from "@/pages/Inbox";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import Shell from "@/components/Shell";
import ErrorBoundary from "@/components/ErrorBoundary";

// Wrap a route's element in an ErrorBoundary so one bad render never blanks the
// whole app. The label shows up in the recovery panel.
const guard = (label, el) => <ErrorBoundary label={label}>{el}</ErrorBoundary>;

function Protected({ children }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    if (!getToken()) { nav("/login"); return; }
    api.get("/auth/me").then(r => { setUser(r.data); setReady(true); })
      .catch(() => { clearToken(); nav("/login"); });
  }, []);
  if (!ready) return (
    <div className="min-h-screen flex items-center justify-center bg-bg-1 text-rust font-mono">
      <span className="animate-blink">BOOTING WRENCH...</span>
    </div>
  );
  return <Shell user={user} setUser={setUser}>{children}</Shell>;
}

function App() {
  return (
    <div className="App grain">
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={guard("login", <Login />)} />
          <Route path="/shop/:shopId" element={guard("shop", <ShopLanding />)} />
          <Route path="/quote" element={<Navigate to="/shop/drunderhood-fortsmith" replace />} />
          <Route path="/snippets" element={guard("snippets", <Snippets />)} />
          <Route path="/snippets/:id" element={guard("snippets", <Snippets />)} />
          <Route path="/privacy" element={guard("privacy", <Privacy />)} />
          <Route path="/terms" element={guard("terms", <Terms />)} />
          <Route path="/*" element={
            <AppProvider>
              <Routes>
                <Route path="/" element={<Protected>{guard("home", <Home />)}</Protected>} />
                <Route path="/chat" element={<Protected>{guard("chat", <Chat />)}</Protected>} />
                <Route path="/call" element={<Protected>{guard("call", <Call />)}</Protected>} />
                <Route path="/charts" element={<Protected>{guard("charts", <Charts />)}</Protected>} />
                <Route path="/library" element={<Protected>{guard("library", <Library />)}</Protected>} />
                <Route path="/vehicles" element={<Protected>{guard("vehicles", <Vehicles />)}</Protected>} />
                <Route path="/datalog" element={<Protected>{guard("datalog", <Datalog />)}</Protected>} />
                <Route path="/memory" element={<Protected>{guard("memory", <Memory />)}</Protected>} />
                <Route path="/vault" element={<Protected>{guard("vault", <Vault />)}</Protected>} />
                <Route path="/cases" element={<Protected>{guard("cases", <Cases />)}</Protected>} />
                <Route path="/team" element={<Protected>{guard("team", <TeamChat />)}</Protected>} />
                <Route path="/letters" element={<Protected>{guard("letters", <Letters />)}</Protected>} />
                <Route path="/jobs" element={<Protected>{guard("jobs", <Jobs />)}</Protected>} />
                <Route path="/email" element={<Protected>{guard("email", <Email />)}</Protected>} />
                <Route path="/diff" element={<Protected>{guard("diff", <DiffTune />)}</Protected>} />
                <Route path="/tune" element={<Protected>{guard("tune", <Tune />)}</Protected>} />
                <Route path="/leads" element={<Protected>{guard("leads", <Leads />)}</Protected>} />
                <Route path="/learn" element={<Protected>{guard("learn", <Learn />)}</Protected>} />
                <Route path="/usage" element={<Protected>{guard("usage", <Suspense fallback={<div className="p-6 text-rust">Loading...</div>}><LlmUsageScreen /></Suspense>)}</Protected>} />
                <Route path="/watchlist" element={<Protected>{guard("watchlist", <Watchlist />)}</Protected>} />
                <Route path="/sms" element={<Protected>{guard("sms", <SmsInbox />)}</Protected>} />
                <Route path="/inbox" element={<Protected>{guard("inbox", <Inbox />)}</Protected>} />
                <Route path="/settings" element={<Protected>{guard("settings", <Settings />)}</Protected>} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </AppProvider>
          } />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

export default App;

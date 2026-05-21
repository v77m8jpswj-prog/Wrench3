import React, { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, Link, useLocation } from "react-router-dom";
import "@/App.css";
import api, { setToken, getToken, clearToken } from "@/api";
import { AppProvider } from "@/AppContext";
import Login from "@/pages/Login";
import Chat from "@/pages/Chat";
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
import Settings from "@/pages/Settings";
import Shell from "@/components/Shell";

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
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <AppProvider>
              <Routes>
                <Route path="/" element={<Protected><Chat /></Protected>} />
                <Route path="/call" element={<Protected><Call /></Protected>} />
                <Route path="/charts" element={<Protected><Charts /></Protected>} />
                <Route path="/library" element={<Protected><Library /></Protected>} />
                <Route path="/vehicles" element={<Protected><Vehicles /></Protected>} />
                <Route path="/datalog" element={<Protected><Datalog /></Protected>} />
                <Route path="/memory" element={<Protected><Memory /></Protected>} />
                <Route path="/vault" element={<Protected><Vault /></Protected>} />
                <Route path="/cases" element={<Protected><Cases /></Protected>} />
                <Route path="/team" element={<Protected><TeamChat /></Protected>} />
                <Route path="/letters" element={<Protected><Letters /></Protected>} />
                <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
                <Route path="/email" element={<Protected><Email /></Protected>} />
                <Route path="/settings" element={<Protected><Settings /></Protected>} />
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

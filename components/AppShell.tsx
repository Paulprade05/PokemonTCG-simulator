"use client";

import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import BottomNav from "./BottomNav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      {/* Content column offset by sidebar on desktop */}
      <div className="md:pl-60">
        <TopBar />
        <main className="px-4 md:px-8 pt-6 pb-28 md:pb-12 max-w-7xl mx-auto w-full">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

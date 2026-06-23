import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { clearAuthToken } from "@/lib/auth-token";
import type { ApiError } from "@workspace/api-client-react";
import { 
  LayoutDashboard, 
  Users, 
  Calendar as CalendarIcon, 
  MessageSquare, 
  Smartphone, 
  Settings as SettingsIcon, 
  Workflow, 
  LogOut,
  Brain,
  MoreHorizontal,
  X,
  FileText,
  Syringe,
  Wallet,
} from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Skeleton } from "./ui/skeleton";
import ClinicLogo from "./clinic-logo";

const mainNav = [
  { href: "/dashboard", label: "Panel", icon: LayoutDashboard },
  { href: "/patients", label: "Pacientes", icon: Users },
  { href: "/appointments", label: "Agenda", icon: CalendarIcon },
  { href: "/treatments", label: "Tratamientos", icon: Syringe },
  { href: "/quotations", label: "Presupuestos", icon: FileText },
  { href: "/billing", label: "Facturación", icon: Wallet },
  { href: "/conversations", label: "Chat", icon: MessageSquare },
];


const moreNav = [
  { href: "/whatsapp", label: "WhatsApp", icon: Smartphone },
  { href: "/automations", label: "Automatizaciones", icon: Workflow },
  { href: "/ai-training", label: "Entrenar IA", icon: Brain },
  { href: "/settings", label: "Configuración", icon: SettingsIcon },
];

const allNav = [...mainNav, ...moreNav];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, isFetching, isError, error } = useGetMe({
    query: {
      retry: (failureCount, err) => {
        const status = (err as ApiError)?.status;
        if (status === 503 || status === 502 || status === 504) return failureCount < 6;
        if (status === 401) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(2000 * (attempt + 1), 10000),
    },
  });
  const [, setLocation] = useLocation();
  const logout = useLogout();
  const [location] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const authStatus = isError ? (error as ApiError)?.status : undefined;
  const waitingForApi = isLoading || isFetching || authStatus === 503 || authStatus === 502 || authStatus === 504;

  useEffect(() => {
    if (waitingForApi) return;
    if (user) return;
    if (authStatus === 401 || authStatus === 403) {
      clearAuthToken();
      setLocation("/login");
    }
  }, [waitingForApi, user, authStatus, setLocation]);

  if (waitingForApi || !user) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><Skeleton className="w-12 h-12 rounded-full" /></div>;
  }

  const handleLogout = () => {
    clearAuthToken();
    logout.mutate(undefined, {
      onSuccess: () => setLocation("/login"),
      onError: () => setLocation("/login"),
    });
  };

  const isMoreActive = moreNav.some(item => location.startsWith(item.href));

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">

      {/* ── Desktop Sidebar ─────────────────────────────────── */}
      <aside className="hidden md:flex bg-sidebar border-r border-sidebar-border w-64 flex-col h-screen sticky top-0">
        <div className="p-5 pb-4">
          <ClinicLogo size="md" />
        </div>

        <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto">
          {allNav.map((item) => {
            const isActive = location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <span className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors cursor-pointer",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                )}>
                  <item.icon className="h-5 w-5 shrink-0" />
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border mt-auto">
          <div className="flex items-center gap-3 mb-3">
            <Avatar className="h-9 w-9 border border-sidebar-border shrink-0">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {(user.name ?? "Ad").substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-sidebar-foreground truncate">{user.name}</span>
              <span className="text-xs text-sidebar-foreground/60 truncate">{user.email}</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 border-sidebar-border"
            onClick={handleLogout}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Cerrar sesión
          </Button>
        </div>
      </aside>

      {/* ── Mobile: Top header ──────────────────────────────── */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-card sticky top-0 z-30">
        <ClinicLogo size="sm" />
        <div className="flex items-center gap-2">
          <Avatar className="h-8 w-8 border border-border">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs">
              {(user.name ?? "Ad").substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>
      </div>

      {/* ── Main content ────────────────────────────────────── */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-8 pb-24 md:pb-8">
          {children}
        </div>
      </main>

      {/* ── Mobile Bottom Navigation ─────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border">
        <div className="flex items-stretch h-16">
          {mainNav.map((item) => {
            const isActive = location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className="flex-1">
                <span className={cn(
                  "flex flex-col items-center justify-center gap-0.5 h-full w-full transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground"
                )}>
                  <item.icon className={cn("h-5 w-5", isActive && "scale-110")} />
                  <span className="text-[10px] font-medium leading-none">{item.label}</span>
                </span>
              </Link>
            );
          })}

          {/* "Más" button */}
          <button
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 h-full transition-colors",
              isMoreActive || moreOpen ? "text-primary" : "text-muted-foreground"
            )}
            onClick={() => setMoreOpen(v => !v)}
          >
            {moreOpen ? <X className="h-5 w-5" /> : <MoreHorizontal className="h-5 w-5" />}
            <span className="text-[10px] font-medium leading-none">Más</span>
          </button>
        </div>
      </nav>

      {/* ── Mobile "Más" overlay panel ───────────────────────── */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMoreOpen(false)}
          />

          {/* Sheet */}
          <div className="relative bg-card rounded-t-2xl border-t border-border pt-3 pb-8 px-4 z-10 shadow-2xl">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />

            <div className="space-y-1 mb-4">
              {moreNav.map((item) => {
                const isActive = location.startsWith(item.href);
                return (
                  <Link key={item.href} href={item.href} onClick={() => setMoreOpen(false)}>
                    <span className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-muted/50"
                    )}>
                      <item.icon className="h-5 w-5 shrink-0" />
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </div>

            <div className="border-t border-border pt-3 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-9 w-9 border border-border shrink-0">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    {(user.name ?? "Ad").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 shrink-0"
                onClick={handleLogout}
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

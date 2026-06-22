import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Patients from "@/pages/patients";
import Appointments from "@/pages/appointments";
import Conversations from "@/pages/conversations";
import WhatsApp from "@/pages/whatsapp";
import Automations from "@/pages/automations";
import Settings from "@/pages/settings";
import AITraining from "@/pages/ai-training";
import Quotations from "@/pages/quotations";
import Treatments from "@/pages/treatments";
import Billing from "@/pages/billing";
import SystemMaintenanceOverlay from "@/components/system-maintenance-overlay";
import { SYSTEM_MAINTENANCE } from "@/lib/maintenance";


import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
import { getAuthToken } from "@/lib/auth-token";

// Configuración de la API en producción
if (import.meta.env.PROD) {
  setBaseUrl("https://dientesbot-api.onrender.com");
}

// Token-based auth — bypasses all cross-origin cookie restrictions
setAuthTokenGetter(getAuthToken);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30000,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/patients" component={Patients} />
      <Route path="/appointments" component={Appointments} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/whatsapp" component={WhatsApp} />
      <Route path="/automations" component={Automations} />
      <Route path="/settings" component={Settings} />
      <Route path="/ai-training" component={AITraining} />
      <Route path="/quotations" component={Quotations} />
      <Route path="/billing" component={Billing} />
      <Route path="/treatments" component={Treatments} />
      <Route path="/" component={Dashboard} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
        {SYSTEM_MAINTENANCE && <SystemMaintenanceOverlay />}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

import { useGetMe, useLogin } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import ClinicLogo from "@/components/clinic-logo";
import { saveAuthToken, getAuthToken } from "@/lib/auth-token";
import type { ApiError } from "@workspace/api-client-react";


const loginSchema = z.object({
  email: z.string().email("Correo electrónico inválido"),
  password: z.string().min(1, "La contraseña es requerida"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const { data: user, isLoading: isLoadingUser } = useGetMe({
    query: {
      enabled: !!getAuthToken(),
      retry: (failureCount, err) => {
        const status = (err as ApiError)?.status;
        if (status === 503 || status === 502 || status === 504) return failureCount < 4;
        return false;
      },
      retryDelay: (attempt) => Math.min(2000 * (attempt + 1), 8000),
    },
  });
  const [, setLocation] = useLocation();
  const loginMutation = useLogin();
  const { toast } = useToast();

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  useEffect(() => {
    if (!isLoadingUser && user) {
      setLocation("/dashboard");
    }
  }, [isLoadingUser, user, setLocation]);

  if (isLoadingUser) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><Skeleton className="w-12 h-12 rounded-full" /></div>;
  }

  if (user) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><Skeleton className="w-12 h-12 rounded-full" /></div>;
  }

  const onSubmit = (values: LoginFormValues) => {
    const attemptLogin = (retriesLeft: number) => {
      loginMutation.mutate(
        { data: values },
        {
          onSuccess: (data: any) => {
            if (data?.token) saveAuthToken(data.token);
            toast({ title: "Bienvenido", description: "Sesión iniciada correctamente." });
            setLocation("/dashboard");
          },
          onError: (err: ApiError | Error) => {
            const status = "status" in err ? err.status : undefined;
            if ((status === 503 || status === 502 || status === 504) && retriesLeft > 0) {
              setTimeout(() => attemptLogin(retriesLeft - 1), 3000);
              return;
            }
            if (status === 401) {
              toast({
                variant: "destructive",
                title: "Error al iniciar sesión",
                description: "Correo o contraseña incorrectos.",
              });
              return;
            }
            toast({
              variant: "destructive",
              title: "No se pudo conectar al servidor",
              description:
                status === 503
                  ? "El servidor está despertando. Espera unos segundos e intenta de nuevo."
                  : "El sistema no respondió. Verifica tu conexión o intenta de nuevo en unos minutos.",
            });
          },
        },
      );
    };
    attemptLogin(3);
  };


  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/20 via-background to-background pointer-events-none" />
      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md z-10"
      >
        <div className="mb-8 flex justify-center">
          <ClinicLogo size="lg" />
        </div>
        
        <Card className="border-border/50 bg-card/50 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-bold tracking-tight">Iniciar sesión</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Correo electrónico</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="tu@email.com"
                  autoComplete="email"
                  {...form.register("email")}
                  className="bg-background"
                />
                {form.formState.errors.email && (
                  <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Contraseña</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  {...form.register("password")}
                  className="bg-background"
                />
                {form.formState.errors.password && (
                  <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
                )}
              </div>
              
              <Button 
                type="submit" 
                className="w-full mt-4 bg-primary hover:bg-primary/90 text-primary-foreground" 
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? "Ingresando..." : "Ingresar"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

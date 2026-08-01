import Layout from "@/components/layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Smartphone, WifiOff, RefreshCw, Clock, CheckCircle2, Loader2, QrCode, Bot, BotOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken } from "@/lib/auth-token";

import { customFetch } from "@workspace/api-client-react";

const api = async <T = any>(path: string, opts?: any): Promise<T> => {
  return customFetch<T>(`/api${path}`, opts);
};

type WAStatus = {
  connected: boolean;
  phone: string | null;
  connectedAt: string | null;
  status: "connected" | "disconnected" | "connecting" | "waiting_qr";
  botEnabled: boolean;
};

type WAQr = {
  qrCode: string | null;
  status: string;
};

export default function WhatsApp() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: status, isLoading: statusLoading } = useQuery<WAStatus>({
    queryKey: ["wa-status"],
    queryFn: () => api("/whatsapp/status"),
    refetchInterval: 3000,
  });

  const { data: qr, isLoading: qrLoading } = useQuery<WAQr>({
    queryKey: ["wa-qr"],
    queryFn: () => api("/whatsapp/qr"),
    enabled: !status?.connected,
    refetchInterval: status?.connected ? false : 3000,
  });

  const disconnect = useMutation({
    mutationFn: () => api("/whatsapp/disconnect", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wa-status"] });
      qc.invalidateQueries({ queryKey: ["wa-qr"] });
      toast({ title: "Sesión de WhatsApp cerrada", description: "Generando nuevo código QR..." });
    },
  });

  const reconnect = useMutation({
    mutationFn: () => api("/whatsapp/reconnect", { method: "POST" }),
    onSuccess: () => {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["wa-status"] });
        qc.invalidateQueries({ queryKey: ["wa-qr"] });
      }, 2000);
    },
  });

  const botToggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api("/whatsapp/bot-toggle", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["wa-status"] });
      toast({
        title: data.botEnabled ? "Bot IA activado" : "Bot IA pausado",
        description: data.botEnabled
          ? "El bot responderá mensajes automáticamente."
          : "El bot está pausado. Los mensajes se recibirán pero no se responderán.",
      });
    },
  });

  const isConnected = status?.connected;
  const isWaitingQr = status?.status === "waiting_qr" || qr?.status === "waiting";
  const isConnecting = status?.status === "connecting";
  const botEnabled = status?.botEnabled ?? true;

  return (
    <Layout>
      <div className="space-y-6 max-w-2xl mx-auto">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Business</h1>
          <p className="text-muted-foreground mt-1">Conecta tu número de WhatsApp para recibir y responder mensajes con IA</p>
        </div>

        {/* Estado de conexión */}
        <Card className="border-border/50 bg-card/80">
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-base">
              <Smartphone className="h-5 w-5" />
              Estado de la conexión
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <div className="space-y-2"><Skeleton className="h-8 w-40" /><Skeleton className="h-4 w-56" /></div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2.5">
                    {isConnected ? (
                      <>
                        <div className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />
                        <Badge className="bg-green-500/20 text-green-300 border-green-500/30">Conectado</Badge>
                      </>
                    ) : isConnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 text-yellow-400 animate-spin" />
                        <Badge className="bg-yellow-500/20 text-yellow-300 border-yellow-500/30">Conectando...</Badge>
                      </>
                    ) : isWaitingQr ? (
                      <>
                        <QrCode className="h-4 w-4 text-blue-400" />
                        <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30">Esperando escaneo QR</Badge>
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline" className="text-muted-foreground">Desconectado</Badge>
                      </>
                    )}
                  </div>
                  {status?.phone && (
                    <p className="text-sm font-mono text-foreground">{status.phone}</p>
                  )}
                  {status?.connectedAt && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      Desde: {new Date(status.connectedAt).toLocaleString("es-CO")}
                    </div>
                  )}
                </div>
                {isConnected && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    {disconnect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Desconectar"}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Control del Bot IA */}
        <Card className={`border-border/50 bg-card/80 transition-all ${botEnabled ? "border-green-500/30" : "border-orange-500/30"}`}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {botEnabled ? (
                  <Bot className="h-5 w-5 text-green-400" />
                ) : (
                  <BotOff className="h-5 w-5 text-orange-400" />
                )}
                <div>
                  <CardTitle className="text-base">Control del Bot IA</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    {botEnabled
                      ? "El bot responde automáticamente a los mensajes de WhatsApp"
                      : "Bot pausado — los mensajes se reciben pero no se responden automáticamente"}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor="bot-toggle" className="text-sm font-medium cursor-pointer">
                  {botEnabled ? (
                    <span className="text-green-400">Activo</span>
                  ) : (
                    <span className="text-orange-400">Pausado</span>
                  )}
                </Label>
                <Switch
                  id="bot-toggle"
                  checked={botEnabled}
                  onCheckedChange={(checked) => botToggle.mutate(checked)}
                  disabled={botToggle.isPending}
                  className="data-[state=checked]:bg-green-500"
                />
              </div>
            </div>
          </CardHeader>
          {!botEnabled && (
            <CardContent className="pt-0">
              <div className="rounded-lg bg-orange-500/10 border border-orange-500/20 p-3 text-xs text-orange-300">
                ⚠️ El bot está pausado. Los mensajes entrantes se guardan en el Chat Center pero no recibirán respuesta automática. Actívalo para reanudar las respuestas con IA.
              </div>
            </CardContent>
          )}
        </Card>

        {/* Panel QR o conectado */}
        <AnimatePresence mode="wait">
          {isConnected ? (
            <motion.div key="connected" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Card className="border-green-500/20 bg-green-500/5">
                <CardContent className="p-8 text-center">
                  <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="h-9 w-9 text-green-400" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-1">¡WhatsApp conectado!</h3>
                  <p className="text-sm text-muted-foreground">
                    Tu número <strong>{status?.phone}</strong> está activo.<br />
                    {botEnabled
                      ? "Los mensajes que lleguen se procesarán con IA automáticamente."
                      : "El bot está pausado. Actívalo arriba para respuestas automáticas."}
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          ) : (
            <motion.div key="qr-panel" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Card className="border-border/50 bg-card/80">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <QrCode className="h-4 w-4 text-accent" />
                    Escanear código QR
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { n: "1", text: "Abre WhatsApp en tu celular" },
                      { n: "2", text: "Ve a Dispositivos vinculados" },
                      { n: "3", text: "Toca en Vincular un dispositivo" },
                      { n: "4", text: "Escanea el código QR de abajo" },
                    ].map(step => (
                      <div key={step.n} className="text-center">
                        <div className="w-8 h-8 rounded-full bg-accent/20 text-accent font-bold text-sm flex items-center justify-center mx-auto mb-2">{step.n}</div>
                        <p className="text-xs text-muted-foreground leading-snug">{step.text}</p>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-col items-center gap-4">
                    {qrLoading ? (
                      <Skeleton className="w-64 h-64 rounded-2xl" />
                    ) : qr?.qrCode ? (
                      <motion.div
                        key={qr.qrCode}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="relative"
                      >
                        <motion.div
                          animate={{
                            boxShadow: [
                              "0 0 0 0 rgba(108,198,73,0.3)",
                              "0 0 0 16px rgba(108,198,73,0)",
                              "0 0 0 0 rgba(108,198,73,0)",
                            ],
                          }}
                          transition={{ duration: 2.5, repeat: Infinity }}
                          className="rounded-2xl overflow-hidden bg-white p-3"
                        >
                          <img
                            src={qr.qrCode}
                            alt="Código QR WhatsApp"
                            className="w-56 h-56 object-contain"
                          />
                        </motion.div>
                        <p className="text-xs text-center text-muted-foreground mt-3">
                          El código se actualiza automáticamente cada 60 segundos
                        </p>
                      </motion.div>
                    ) : (
                      <div className="w-64 h-64 border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center gap-3 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin opacity-40" />
                        <p className="text-sm">Generando código QR...</p>
                        <p className="text-xs text-center px-4">Espera unos segundos mientras el sistema se conecta a WhatsApp</p>
                      </div>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={reconnect.isPending}
                      onClick={() => {
                        reconnect.mutate();
                        qc.invalidateQueries({ queryKey: ["wa-qr"] });
                        qc.invalidateQueries({ queryKey: ["wa-status"] });
                      }}
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${reconnect.isPending ? "animate-spin" : ""}`} />
                      Actualizar
                    </Button>
                  </div>

                  <div className="rounded-xl bg-background/60 border border-border/30 p-4 text-xs text-muted-foreground space-y-1.5">
                    <p className="font-medium text-foreground">¿Cómo funciona?</p>
                    <p>• Usa la misma tecnología que WhatsApp Web — sin costos ni tokens adicionales.</p>
                    <p>• Tu número debe tener WhatsApp activo y estar disponible en tu celular.</p>
                    <p>• Una vez conectado, los mensajes entrantes serán respondidos automáticamente por la IA.</p>
                    <p>• La sesión se mantiene activa aunque cierres el navegador.</p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Layout>
  );
}

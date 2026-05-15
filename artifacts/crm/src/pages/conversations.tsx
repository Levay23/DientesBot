import Layout from "@/components/layout";
import { useListConversations, useGetConversation, useSendMessage, useSetConversationMode,
  getListConversationsQueryKey, getGetConversationQueryKey, getGetMessagesQueryKey
} from "@workspace/api-client-react";
import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Search, Send, Bot, User, Phone } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

function formatTime(dt: string | null | undefined) {
  if (!dt) return "";
  const d = new Date(dt);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

const senderLabel: Record<string, string> = {
  patient: "Paciente",
  agent: "Agente",
  ai: "IA",
};

export default function Conversations() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();


  const [lastSynced, setLastSynced] = useState<Date>(new Date());
  const params = { search: search || undefined };
  const { data: conversations, isLoading } = useListConversations(params, {
    query: { 
      queryKey: getListConversationsQueryKey(params), 
      refetchInterval: 2500,
      onSuccess: () => setLastSynced(new Date())
    }
  });
  const { data: detail, isLoading: detailLoading } = useGetConversation(selectedId!, {
    query: { 
      enabled: !!selectedId, 
      queryKey: getGetConversationQueryKey(selectedId!), 
      refetchInterval: 1500,
      onSuccess: () => setLastSynced(new Date())
    }
  });
  const sendMessage = useSendMessage();
  const setMode = useSetConversationMode();

  const handleSend = () => {
    if (!message.trim() || !selectedId) return;
    sendMessage.mutate({ conversationId: selectedId, data: { content: message } }, {
      onSuccess: () => {
        setMessage("");
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(selectedId) });
        queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey(selectedId) });
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      }
    });
  };

  const toggleAI = (id: number, aiMode: boolean) => {
    setMode.mutate({ id, data: { aiMode } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id) });
      }
    });
  };

  const selected = detail?.conversation;
  const messages = detail?.messages ?? [];
  const patient = detail?.patient;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, selectedId]);


  return (
    <Layout>
      <div className="h-[calc(100vh-8rem)] flex gap-0 rounded-xl overflow-hidden border border-border/50">
        {/* Lista de conversaciones */}
        <div className="w-80 flex-shrink-0 bg-card/80 border-r border-border/50 flex flex-col">
          <div className="p-4 border-b border-border/50">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Chat Center</h2>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-widest">
                <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                Sincronizado {lastSynced.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Buscar..." className="pl-9 bg-background border-border h-9" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="p-4 space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
            ) : !conversations?.length ? (
              <div className="text-center py-12 text-muted-foreground text-sm px-4">
                <Phone className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>Sin conversaciones aún.</p>
                <p className="mt-1 text-xs">Los mensajes de WhatsApp aparecerán aquí.</p>
              </div>
            ) : !Array.isArray(conversations) ? null : conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={cn(
                  "p-4 cursor-pointer hover:bg-background/50 transition-colors border-b border-border/30",
                  selectedId === conv.id && "bg-background/70 border-l-2 border-l-accent"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold text-primary-foreground">{conv.patientName.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-foreground truncate">{conv.patientName}</p>
                      <p className="text-xs text-muted-foreground truncate">{conv.lastMessage ?? "Sin mensajes"}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-xs text-muted-foreground">{formatTime(conv.lastMessageAt)}</span>
                    {conv.unreadCount > 0 && (
                      <Badge className="bg-accent text-accent-foreground text-xs px-1.5 py-0 min-w-5 h-5 flex items-center justify-center">
                        {conv.unreadCount}
                      </Badge>
                    )}
                    {conv.aiMode && <Bot className="h-3 w-3 text-accent" />}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Área de chat */}
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center bg-background/30">
            <div className="text-center text-muted-foreground">
              <Phone className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>Selecciona una conversación para ver los mensajes</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col bg-background/20">
            {/* Encabezado del chat */}
            <div className="px-6 py-4 border-b border-border/50 bg-card/50 flex items-center justify-between">
              {detailLoading ? <Skeleton className="h-8 w-48" /> : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-sm font-bold text-primary-foreground">{selected?.patientName.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">{selected?.patientName}</p>
                      <p className="text-xs text-muted-foreground">{selected?.phone}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                      <Switch
                        checked={selected?.aiMode ?? true}
                        onCheckedChange={v => toggleAI(selected!.id, v)}
                      />
                      <Label className="text-xs text-muted-foreground">{selected?.aiMode ? "IA Activa" : "Manual"}</Label>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Mensajes */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">

              {detailLoading ? (
                <div className="space-y-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className={`h-12 w-2/3 ${i % 2 === 0 ? "" : "ml-auto"}`} />)}</div>
              ) : !Array.isArray(messages) || !messages.length ? (
                <div className="text-center text-muted-foreground py-12 text-sm">Sin mensajes en esta conversación</div>
              ) : messages.map(msg => (
                <div key={msg.id} className={cn("flex", msg.sender === "patient" ? "justify-start" : "justify-end")}>
                  <div className={cn(
                    "max-w-xs lg:max-w-md rounded-2xl px-4 py-2.5 text-sm",
                    msg.sender === "patient" ? "bg-card border border-border/50 text-foreground rounded-tl-sm" :
                    msg.sender === "ai" ? "bg-accent/20 border border-accent/30 text-foreground rounded-tr-sm" :
                    "bg-primary text-primary-foreground rounded-tr-sm"
                  )}>
                    {msg.sender === "ai" && (
                      <div className="flex items-center gap-1 mb-1">
                        <Bot className="h-3 w-3 text-accent" />
                        <span className="text-xs text-accent font-medium">Asistente IA</span>
                      </div>
                    )}
                    {msg.sender === "agent" && (
                      <div className="flex items-center gap-1 mb-1">
                        <User className="h-3 w-3 text-primary-foreground/70" />
                        <span className="text-xs text-primary-foreground/70 font-medium">Agente</span>
                      </div>
                    )}
                    <p>{msg.content}</p>
                    <p className={cn("text-xs mt-1", msg.sender === "patient" ? "text-muted-foreground" : "text-primary-foreground/70")}>
                      {formatTime(msg.sentAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Campo de mensaje */}
            <div className="p-4 border-t border-border/50 bg-card/50 flex gap-3">
              <Input
                placeholder="Escribe un mensaje como agente..."
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleSend()}
                className="bg-background border-border"
              />
              <Button onClick={handleSend} disabled={sendMessage.isPending || !message.trim()} className="bg-primary px-4">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

      </div>
    </Layout>
  );
}

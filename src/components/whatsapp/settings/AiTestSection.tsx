import { useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, GraduationCap, Sparkles } from "lucide-react";
import { AiTestChat } from "@/components/setup/AiTestChat";
import { AiOwnerNotes } from "@/components/setup/AiOwnerNotes";
import { AiImagesEditor } from "@/components/setup/AiImagesEditor";
import { HandoffAlertPhone } from "@/components/setup/HandoffAlertPhone";
import { AiHandoffReasons } from "@/components/setup/AiHandoffReasons";
import { WhatsAppConnect } from "@/components/setup/WhatsAppConnect";
import { signupStatus } from "@/lib/selfSetup";

const IDEAS = [
  "Peça orçamento (\"quanto fica pra 70 pessoas no sábado?\")",
  "Pergunte se tem data livre num mês",
  "Peça fotos, o vídeo ou os pacotes",
  "Peça para visitar o buffet",
  "Pergunte uma regra (bolo de fora, decoração, horário)",
];

/**
 * "Minha IA": testar como a IA atende, sem nada sair pelo WhatsApp. O teste é
 * de toda a equipe; o resto (motivos de passagem, alerta, imagens) só de quem
 * gerencia o buffet.
 */
export function AiTestSection({ canManage = true }: { canManage?: boolean }) {
  const { currentCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const [taught, setTaught] = useState(0);
  if (!currentCompany) return null;
  return (
    <div className="max-w-xl space-y-4">
      {canManage && signupStatus(currentCompany.settings) && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="font-medium">WhatsApp do buffet</p>
            <WhatsAppConnect companyId={currentCompany.id} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1">
            <p className="flex items-center gap-2 font-medium"><Sparkles className="h-4 w-4 text-primary" /> Testar a minha IA</p>
            <p className="text-sm text-muted-foreground">
              Converse com a sua IA como se fosse um cliente e veja como ela responde: com a sua agenda, os seus valores,
              fotos e pacotes. É só um teste: nada vai para o WhatsApp e nada fica gravado.
            </p>
          </div>
          <ul className="space-y-1.5 text-sm">
            {IDEAS.map((i) => (
              <li key={i} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" /> {i}</li>
            ))}
          </ul>
          <Button onClick={() => setOpen(true)} className="w-full sm:w-auto"><Sparkles className="mr-2 h-4 w-4" /> Conversar com a minha IA</Button>
          <p className="text-xs text-muted-foreground">
            {canManage ? "Alguma resposta errada? Toque em \"Corrigir\" embaixo dela e ensine como deveria ser." : "Alguma resposta errada? Avise quem cuida do buffet."}
          </p>
        </CardContent>
      </Card>
      {canManage && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="flex items-center gap-2 font-medium"><GraduationCap className="h-4 w-4 text-primary" /> Ensinar a IA</p>
            <AiOwnerNotes companyId={currentCompany.id} refreshKey={taught} />
          </CardContent>
        </Card>
      )}
      {canManage && (<>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="font-medium">O que a IA passou para a equipe</p>
          <AiHandoffReasons companyId={currentCompany.id} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="font-medium">Alerta de cliente sem resposta</p>
          <HandoffAlertPhone companyId={currentCompany.id} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="font-medium">Imagens da IA</p>
          <AiImagesEditor companyId={currentCompany.id} showFollowUps />
        </CardContent>
      </Card>
      </>)}
      <AiTestChat open={open} onOpenChange={setOpen} companyId={currentCompany.id} canTeach={canManage} onTaught={() => setTaught((n) => n + 1)} />
    </div>
  );
}

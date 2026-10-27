import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

// Pergunta de escolha com "✏️ Outra resposta": quando nenhuma opção serve
// (Rodrigo, Mega Magic 27/10: estacionamento conveniado não tinha opção), a
// pessoa escreve a dela. O texto vai igual para a IA ("Estacionamento: …").
export const CUSTOM_OPTION = "__outra_resposta__";

export function isCustomAnswer(value: string | undefined, options: readonly string[] | undefined): boolean {
  const v = (value || "").trim();
  return !!v && !(options || []).includes(v);
}

interface Props {
  id?: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  triggerClassName?: string;
}

export function SelectOrCustom({ id, value, options, onChange, triggerClassName }: Props) {
  const [custom, setCustom] = useState(() => isCustomAnswer(value, options));
  // Valor trocado de fora (ex.: descartar alterações): acompanha
  useEffect(() => {
    if (isCustomAnswer(value, options)) setCustom(true);
    else if (value) setCustom(false);
  }, [value, options]);

  return (
    <div className="space-y-2">
      <Select
        value={custom ? CUSTOM_OPTION : value || ""}
        onValueChange={(v) => {
          if (v === CUSTOM_OPTION) {
            setCustom(true);
            if (!isCustomAnswer(value, options)) onChange("");
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
      >
        <SelectTrigger id={id} className={triggerClassName}>
          <SelectValue placeholder="Selecione uma opção" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
          <SelectItem value={CUSTOM_OPTION}>✏️ Outra resposta (escrever)</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <Input
          autoFocus={!value}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 text-base sm:text-sm"
          placeholder="Escreva a resposta do seu buffet — a IA usa exatamente isso"
        />
      )}
    </div>
  );
}

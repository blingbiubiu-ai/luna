import { Languages } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
export function LanguageToggle() {
  const {locale, setLocale, t} = useTranslation();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t("Language")}><Languages className="size-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuRadioGroup value={locale} onValueChange={value => {if (value === "en" || value === "zh-CN") setLocale(value);}}>
      <DropdownMenuRadioItem value="zh-CN">简体中文</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>;
}

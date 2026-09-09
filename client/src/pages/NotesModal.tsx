import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export type NotesModalType = "check_in_branch" | "check_in_external" | "check_out_short" | "check_out_general";

interface NotesModalProps {
  open: boolean;
  type: NotesModalType;
  visitNotes: string;
  onVisitNotesChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  isPending: boolean;
}

// ── مودال الملاحظات (كان inline في BranchCheckIn — نفس النصوص والسلوك) ──────
// الحالات: دخول فرع / مأمورية خارجية / خروج زيارة قصيرة / خروج عادي
export default function NotesModal({
  open,
  type,
  visitNotes,
  onVisitNotesChange,
  onClose,
  onSubmit,
  isPending,
}: NotesModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) onClose();
    }}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>
            {type === "check_in_external" && "تفاصيل المأمورية الخارجية"}
            {type === "check_in_branch" && "تسجيل زيارة فرع"}
            {type === "check_out_short" && "توضيح سبب الزيارة القصيرة"}
            {type === "check_out_general" && "تسجيل الخروج"}
          </DialogTitle>
          <DialogDescription>
            {type === "check_in_external" && "أدخل الوجهة أو سبب المأمورية الخارجية لتوثيقها."}
            {type === "check_in_branch" && "يمكنك كتابة ملاحظات إضافية لهذه الزيارة (اختياري)."}
            {type === "check_out_short" && "مدة الزيارة كانت قصيرة جداً. يجب توضيح السبب لمديرك."}
            {type === "check_out_general" && "هل تريد إضافة ملاحظات عن هذه الزيارة قبل الخروج؟ (اختياري)"}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <Textarea
            placeholder={type === "check_in_branch" || type === "check_out_general" ? "ملاحظات اختيارية..." : "اكتب التفاصيل هنا..."}
            value={visitNotes}
            onChange={(e) => onVisitNotesChange(e.target.value)}
            className="min-h-[120px] resize-none focus-visible:ring-[#0fa5f8]"
          />
        </div>
        <DialogFooter>
          <button
            onClick={onSubmit}
            disabled={isPending}
            className="w-full bg-[#0fa5f8] hover:bg-[#0fa5f8]/90 text-white font-bold py-3 px-4 rounded-xl flex justify-center items-center gap-2"
          >
            {isPending && <Loader2 className="animate-spin w-5 h-5" />}
            {type === "check_in_branch" ? "تسجيل الدخول الآن" :
             (type === "check_out_short" || type === "check_out_general") ? "تأكيد وتسجيل الخروج" : "بدء المأمورية"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

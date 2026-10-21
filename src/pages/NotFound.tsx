import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AlleyBadge } from "@/components/brand/Logo";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center py-24 text-center">
      <AlleyBadge className="h-24 w-24 text-primary/25" showText={false} />
      <p className="eyebrow mt-8">404</p>
      <h1 className="mt-3 font-display text-[34px] font-semibold leading-tight tracking-tight">
        This room is empty.
      </h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
        The page you're after doesn't exist — or your role doesn't have access to
        it. Head back to the overview and we'll pick up from there.
      </p>
      <Button asChild className="mt-8">
        <Link to="/app">
          <ArrowLeft className="size-4" />
          Back to overview
        </Link>
      </Button>
    </div>
  );
}

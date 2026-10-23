// Adapted from current shadcn base-nova; license and source digests: ../../NOTICE, ../../provenance.json.
"use client";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}
function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}
function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  );
}
export { Collapsible, CollapsibleTrigger, CollapsibleContent };

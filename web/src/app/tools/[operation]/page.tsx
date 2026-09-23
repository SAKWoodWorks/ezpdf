import { notFound } from "next/navigation";
import { JobUploader } from "@/components/job-uploader";
import { Workbench } from "@/components/workbench";
import { requirePageUser } from "@/lib/page-auth";
import { TOOLS } from "@/lib/tool-info";
import type { Operation } from "@/lib/jobs";

export default async function ToolPage({ params }: { params: Promise<{ operation: string }> }) {
  await requirePageUser();
  const { operation } = await params;
  if (!Object.hasOwn(TOOLS, operation)) notFound();
  const selected = operation as Operation;
  const tool = TOOLS[selected];
  return <Workbench operation={selected}><div className="page-intro"><h1>{tool.title}</h1><p>{tool.description}</p></div><JobUploader key={selected} operation={selected} /></Workbench>;
}

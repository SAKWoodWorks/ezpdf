import Link from "next/link";
import { Workbench } from "@/components/workbench";
import { JobStatus } from "@/components/job-status";
import { listOwnedJobs } from "@/lib/job-history";
import { requirePageUser } from "@/lib/page-auth";
import { TOOLS } from "@/lib/tool-info";

export default async function Home() {
  const user = await requirePageUser();
  const jobs = await listOwnedJobs(user.id);
  return <Workbench><div className="page-intro"><h1>Make room for the next task.</h1><p>Choose a tool, add your files, and take your result with you.</p></div>
    <section aria-labelledby="tools-heading"><h2 id="tools-heading">Start with a document</h2><div className="tool-list">{Object.entries(TOOLS).map(([key, tool]) => <Link key={key} href={`/tools/${key}`} className="tool-link"><span>{tool.title}</span><span>{tool.description}</span><span aria-hidden="true">↗</span></Link>)}</div></section>
    <section aria-labelledby="jobs-heading" className="recent-jobs"><div className="section-heading"><h2 id="jobs-heading">Recent jobs</h2><span>Latest 50 active records</span></div>{jobs.length ? <div className="job-list">{jobs.map(job => <JobStatus key={job.id} initialJob={job} />)}</div> : <div className="empty-state"><p>No recent files here yet.</p><p>Choose a tool above to start. Your temporary results will appear here.</p></div>}</section>
  </Workbench>;
}

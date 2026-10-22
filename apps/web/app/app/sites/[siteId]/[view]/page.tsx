import Workspace from '../../../../../components/workspace';
export default async function Page({
  params,
}: {
  params: Promise<{ siteId: string; view: string }>;
}) {
  const p = await params;
  return <Workspace initialSite={p.siteId} initialView={p.view} />;
}

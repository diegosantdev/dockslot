import {DockSlot} from '@dockslot/sdk';
const client=new DockSlot({baseUrl:process.env.DOCKSLOT_URL||'http://localhost:4000',token:process.env.DOCKSLOT_TOKEN||''});
const siteId=process.env.DOCKSLOT_SITE_ID||'site_demo';
console.log((await client.calendar(siteId)).site);
// Generate a proposal, display assignments to a human, then call client.apply(proposal)
// only after explicit operator approval. Never automatically apply generated proposals.

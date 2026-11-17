import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { decidePersonDevice, getOrgSecurity, saveOrgSecurity } from "../../lib/api";
import { PendingDevices } from "../security/PendingDevices";
import { SecurityRulesForm } from "../security/SecurityRulesForm";
import { List } from "./shared";

// The organization's sign-in rules for phones and new devices, and the
// devices waiting for approval. The platform's rules are the loosest allowed;
// these can only make them stricter.
export function SecurityTab({ ctx }) {
  const queryClient = useQueryClient();
  const key = ["org-security", ctx.orgId ?? "mine"];
  const query = useQuery({ queryKey: key, queryFn: () => getOrgSecurity(ctx.orgId) });
  const data = query.data;

  const save = useMutation({
    mutationFn: (policy) => saveOrgSecurity(policy, ctx.orgId),
    onSuccess: (result) => queryClient.setQueryData(key, (current) => ({ ...current, policy: result.policy, effective: result.effective })),
  });
  const decide = useMutation({
    mutationFn: ({ device, decision }) => decidePersonDevice({ orgId: ctx.orgId }, device.user_id, device.id, decision),
    onMutate: async ({ device }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (current) => current && { ...current, pending: current.pending.filter((row) => row.id !== device.id) });
      return { before };
    },
    onError: (_error, _variables, context) => queryClient.setQueryData(key, context?.before),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ctx.orgKey });
    },
  });

  if (query.error) return <p className="text-sm text-ops-red">{query.error.message}</p>;

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="glass-panel rounded-lg p-5">
        <h2 className="text-sm font-bold text-neutral-100">Sign-in rules</h2>
        <p className="mb-4 mt-1 text-[12px] text-neutral-500">
          For lost or captured phones. Phone limits apply to phones only; control-room computers are left alone.
        </p>
        {query.isLoading ? (
          <div className="space-y-3">{[0, 1, 2].map((row) => <div key={row} className="h-10 animate-pulse rounded bg-white/[0.05]" />)}</div>
        ) : (
          <SecurityRulesForm
            policy={data.policy}
            ceiling={data.platform}
            canEdit={data.can_edit}
            onSave={(policy) => save.mutate(policy)}
            saving={save.isPending}
            saved={save.isSuccess}
            error={save.error?.message}
          />
        )}
      </div>
      <div className="space-y-4">
        <List title={`Waiting for approval${data ? ` · ${data.pending.length}` : ""}`}>
          <div className="px-4">
            {query.isLoading ? <div className="my-3 h-10 animate-pulse rounded bg-white/[0.05]" /> : (
              <PendingDevices devices={data.pending} busy={decide.isPending} onDecide={(device, decision) => decide.mutate({ device, decision })} />
            )}
          </div>
        </List>
        {decide.error ? <p className="text-[11px] text-ops-red">{decide.error.message}</p> : null}
        <div className="glass-panel rounded-lg p-4 text-[12px] text-neutral-400">
          <h3 className="mb-1 text-[12px] font-bold text-neutral-200">If a phone is lost or taken</h3>
          <p>Open People, choose the person, and sign the phone out or report it lost. It stops working within seconds.</p>
          <p className="mt-2">Each person can also set a panic password and PIN under My devices & PIN in their menu.</p>
        </div>
      </div>
    </section>
  );
}

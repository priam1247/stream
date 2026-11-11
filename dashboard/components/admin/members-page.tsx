'use client';

import { Search, ShieldBan, ShieldCheck, UserCheck, UserPlus } from 'lucide-react';
import { MemberFilter, MEMBER_FILTER_LABELS } from './constants';

import { useConsole } from './console-context';

export function MembersPage() {
  const { addingMember, approvedMembersCount, busyEmail, busyNumber, data, events, filteredMembers, handleAddMember, handleApproval, handleToggleMember, memberFilter, memberSearch, newMemberEmail, newMemberName, setMemberFilter, setMemberSearch, setNewMemberEmail, setNewMemberName } = useConsole();

  return (
    <>
      <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink sm:text-base">
            <UserCheck className="h-4 w-4 text-accent" />
            Members
          </h2>

          <div className="flex items-center gap-1 rounded-xl bg-ink/5 p-1 text-xs">
            {(['all', 'approved', 'denied'] as MemberFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setMemberFilter(f)}
                className={`rounded-lg px-2.5 py-1 font-semibold capitalize transition ${
                  memberFilter === f
                    ? 'bg-paper text-ink shadow-sm'
                    : 'text-ink/60 hover:text-ink'
                }`}
              >
                {MEMBER_FILTER_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {data.users.some((item) => item.approval === 'pending') && <div role="region" className="mt-4 rounded-xl border border-accent/25 bg-accent/10 p-3" aria-label="Pending link approvals">
          <h3 className="text-xs font-bold text-accent">Link requests</h3>
          <p className="mt-1 text-[11px] text-accent">Members link first. Approve only after their connection is ready.</p>
          <div className="mt-2 space-y-2">{data.users.filter((item) => item.approval === 'pending').map((item) => {
            const linked = data.botReachable && data.accounts?.some((account) => account.number === item.number && account.sessionId && account.claimCurrent === true && ['connected', 'connecting', 'paused'].includes(account.state));
            return <div key={item.number} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-paper p-2.5">
              <div className="min-w-0"><p className="truncate text-xs font-semibold text-ink/80">{item.label || 'Member'} · {item.number}</p><p className="truncate text-[11px] text-ink/60">{item.addedBy || 'Member'} · {linked ? 'Linked, awaiting approval' : 'Waiting for link or service'}</p></div>
              <div className="flex gap-2"><button type="button" disabled={!linked || busyNumber === item.number} onClick={() => void handleApproval(item.number, 'approve')} className="min-h-[40px] rounded-lg bg-accent px-3 text-xs font-semibold text-paper disabled:opacity-40">Approve</button><button type="button" disabled={busyNumber === item.number} onClick={() => void handleApproval(item.number, 'reject')} className="min-h-[40px] rounded-lg border border-ink/10 px-3 text-xs font-semibold text-ink/60 disabled:opacity-40">Reject</button></div>
            </div>;
          })}</div>
        </div>}

        <p className="mt-2 text-xs leading-5 text-ink/60">{approvedMembersCount} of {data.members.length} approved.</p>
        <form
          onSubmit={handleAddMember}
          className="mt-3.5 grid grid-cols-1 gap-2.5 rounded-xl border border-ink/10 bg-ink/5 p-3 sm:grid-cols-[1.2fr_1fr_auto] sm:items-end"
        >
          <div className="min-w-0">
            <label
              htmlFor="add-member-email"
              className="mb-1 block text-xs font-medium text-ink/80"
            >
              Email
            </label>
            <input
              id="add-member-email"
              type="email"
              required
              value={newMemberEmail}
              onChange={(e) => setNewMemberEmail(e.target.value)}
              placeholder="member@gmail.com"
              className="w-full rounded-xl border border-ink/20 bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="min-w-0">
            <label
              htmlFor="add-member-name"
              className="mb-1 block text-xs font-medium text-ink/80"
            >
              Name
            </label>
            <input
              id="add-member-name"
              type="text"
              value={newMemberName}
              onChange={(e) => setNewMemberName(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-xl border border-ink/20 bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={addingMember}
            className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-xs font-semibold text-paper shadow-sm transition hover:bg-accent disabled:opacity-60"
          >
            <UserPlus className="h-4 w-4" />
            {addingMember ? 'Saving…' : 'Allow'}
          </button>
        </form>

        <div className="relative mt-3.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
          <input
            type="search"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            placeholder="Filter members…"
            className="w-full rounded-xl border border-ink/10 bg-ink/5 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink/40 focus:border-accent focus:bg-paper focus:outline-none"
          />
        </div>

        <div className="mt-3 divide-y divide-ink/5">
          {filteredMembers.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs text-ink/40">
              No members found
            </p>
          ) : (
            filteredMembers.map((member) => {
              const busy = busyEmail === member.email;
              return (
                <div
                  key={member.email}
                  className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold text-ink">
                        {member.name}
                      </span>
                      {member.isAdmin ? (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase text-accent ring-1 ring-accent/25">
                          Root
                        </span>
                      ) : member.allowed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-ink/5 px-2 py-0.5 text-[10px] font-bold uppercase text-ink ring-1 ring-ink/15">
                          <ShieldCheck className="h-3 w-3" />
                          Approved
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase text-accent ring-1 ring-accent/25">
                          <ShieldBan className="h-3 w-3" />
                          Not approved
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink/60">
                      <span className="break-all font-mono text-ink/80">
                        {member.email}
                      </span>
                      <span>·</span>
                      <span>{member.numbersCount} {member.numbersCount === 1 ? 'number' : 'numbers'}</span>
                      <span>·</span><span>{member.isVerified ? 'Verified' : 'Not verified'}</span>
                    </div>
                    {!member.isAdmin && events.find((event) => event.actor === member.email) && <p className="mt-1 text-xs text-ink/60">Last recorded activity {new Date(events.find((event) => event.actor === member.email)!.createdAt).toLocaleDateString()}</p>}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {member.isAdmin ? (
                      <span className="font-mono text-[11px] font-semibold text-ink/40">Owner</span>
                    ) : (<>
                      <button type="button" disabled={busy} onClick={() => handleToggleMember(member.email, !member.allowed, member.name)} className={`min-h-10 rounded-xl px-3.5 text-xs font-semibold transition disabled:opacity-50 ${member.allowed ? 'border border-accent/25 bg-accent/10 text-accent hover:bg-accent/15' : 'bg-accent text-paper hover:bg-accent'}`}>
                        {busy ? 'Saving…' : member.allowed ? 'Block' : 'Allow'}
                      </button>
                    </>)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}

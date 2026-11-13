// One row of Easy's confirm screen: its label on the left (above on a narrow window) and what it says on the right.
export function Row({
  label,
  children,
  testId,
}: {
  label: string
  children: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-1 gap-x-6 gap-y-1 border-t py-4 sm:grid-cols-[11rem_1fr]"
    >
      <h2 className="text-sm font-semibold">{label}</h2>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  )
}

import { useState, type ChangeEvent, type SubmitEvent } from 'react'
import { LockKeyhole, ShieldCheck } from 'lucide-react'
import { login } from './api'

type AuthViewProps = {
  onSuccess: () => void
}

export function AuthView({ onSuccess }: AuthViewProps) {
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePinChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPin(event.target.value)
  }

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    if (!pin.trim()) {
      setError('PIN is required')
      return
    }

    setSubmitting(true)

    try {
      await login(pin)
      onSuccess()
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message)
      } else {
        setError('Unexpected error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <section className="relative w-full max-w-md overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/55 p-8 shadow-2xl shadow-black/40 backdrop-blur-2xl">
        <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-rose-400/60 to-transparent" />
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-rose-500/15 p-3 ring-1 ring-rose-400/20 text-rose-100">
            <ShieldCheck className="h-6 w-6" strokeWidth={1.8} />
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-rose-300/70">
            Raspcast
          </p>
        </div>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/6 px-4 py-3 shadow-lg shadow-black/15 ring-1 ring-inset ring-white/5">
            <LockKeyhole className="h-5 w-5 text-slate-400" strokeWidth={1.8} />
            <input
              className="w-full border-0 bg-transparent text-lg tracking-[0.25em] text-white outline-none placeholder:text-slate-500"
              id="pin"
              type="password"
              value={pin}
              onChange={handlePinChange}
              autoComplete="current-password"
              inputMode="numeric"
              placeholder="••••"
            />
          </div>

          <button
            className="inline-flex w-full items-center justify-center rounded-2xl bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition duration-200 hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
            type="submit"
            disabled={submitting}
          >
            {submitting ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        {error ? (
          <p className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}

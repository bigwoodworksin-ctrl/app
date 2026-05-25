"use client";

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { compressImage } from "@/lib/image";

type SearchRow = {
  rowNumber: number;
  photoLink: string;
  status: string;
  personalization: string;
  priority: 1 | 2;
};

const TOKEN_KEY = "order-photo-manager-token";
const SEARCH_DELAY_MS = 300;

function friendlyStatus(status: string): string {
  return status.trim() || "No status";
}

export default function HomePage() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [uploadingRow, setUploadingRow] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setToken(window.localStorage.getItem(TOKEN_KEY));

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  const trimmedQuery = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    if (!token) {
      return;
    }

    if (!trimmedQuery) {
      setRows([]);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setError("");

      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`, {
          headers: {
            "x-app-token": token
          },
          signal: controller.signal
        });
        const data = (await response.json()) as { rows?: SearchRow[]; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Search failed.");
        }

        setRows(data.rows ?? []);
      } catch (searchError) {
        if ((searchError as Error).name !== "AbortError") {
          setRows([]);
          setError((searchError as Error).message);
        }
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [token, trimmedQuery]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoggingIn(true);
    setError("");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ password })
      });
      const data = (await response.json()) as { token?: string; error?: string };

      if (!response.ok || !data.token) {
        throw new Error(data.error ?? "Wrong password. Please try again.");
      }

      window.localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword("");
    } catch (loginError) {
      setError((loginError as Error).message);
    } finally {
      setIsLoggingIn(false);
    }
  }

  function handleSignOut() {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setRows([]);
    setQuery("");
    setError("");
  }

  async function handlePhotoChange(row: SearchRow, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || !token) {
      return;
    }

    setUploadingRow(row.rowNumber);
    setError("");

    try {
      const compressed = await compressImage(file);
      const response = await fetch("/api/upload-photo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          ...compressed
        })
      });
      const data = (await response.json()) as { success?: boolean; imageUrl?: string; error?: string };

      if (!response.ok || !data.success || !data.imageUrl) {
        throw new Error(data.error ?? "Photo upload failed.");
      }

      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.rowNumber === row.rowNumber ? { ...currentRow, photoLink: data.imageUrl ?? "" } : currentRow
        )
      );
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploadingRow(null);
    }
  }

  if (!token) {
    return (
      <main className="app-shell auth-shell">
        <section className="auth-panel" aria-labelledby="login-title">
          <div>
            <p className="eyebrow">Private PWA</p>
            <h1 id="login-title">Order Photo Manager</h1>
            <p className="muted">Enter the app password to search orders and add photos.</p>
          </div>

          <form className="login-form" onSubmit={handleLogin}>
            <label htmlFor="password">App password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
            />
            <button className="primary-button" disabled={isLoggingIn || !password}>
              {isLoggingIn ? "Checking..." : "Unlock"}
            </button>
          </form>

          {error ? <p className="error-message">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Google Sheets + Drive</p>
          <h1>Order Photo Manager</h1>
        </div>
        <button className="ghost-button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <section className="search-panel" aria-label="Search orders">
        <label htmlFor="search">Search personalization</label>
        <input
          id="search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, phrase, or custom text"
          autoFocus
        />
        <div className="result-meta">
          <span>{trimmedQuery ? `${rows.length} result${rows.length === 1 ? "" : "s"}` : "Start typing to search"}</span>
          {isSearching ? <span>Searching...</span> : null}
        </div>
      </section>

      {error ? <p className="error-message">{error}</p> : null}

      <section className="results-list" aria-live="polite">
        {!isSearching && trimmedQuery && rows.length === 0 && !error ? (
          <div className="empty-state">
            <h2>No matches found</h2>
            <p>Try another spelling or a shorter part of the personalization text.</p>
          </div>
        ) : null}

        {rows.map((row) => (
          <article className="result-card" key={row.rowNumber}>
            <div className="card-head">
              <span className="row-number">Row {row.rowNumber}</span>
              <span className={`status-badge ${row.priority === 2 ? "status-done" : "status-active"}`}>
                {friendlyStatus(row.status)}
              </span>
            </div>

            <p className="personalization">{row.personalization || "No personalization text"}</p>

            {row.photoLink ? (
              <a className="photo-link" href={row.photoLink} target="_blank" rel="noreferrer">
                Open Photo
              </a>
            ) : (
              <p className="muted">No photo link yet</p>
            )}

            <label className={`file-button ${uploadingRow === row.rowNumber ? "is-loading" : ""}`}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={uploadingRow !== null}
                onChange={(event) => handlePhotoChange(row, event)}
              />
              {uploadingRow === row.rowNumber ? "Uploading..." : "Add Photo"}
            </label>
          </article>
        ))}
      </section>
    </main>
  );
}

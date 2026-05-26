"use client";

import type { ChangeEvent } from "react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { compressImage } from "@/lib/image";

type SearchRow = {
  rowNumber: number;
  photoLink: string;
  photoLinks: PhotoSlot[];
  status: string;
  personalization: string;
  priority: 1 | 2;
};

type PhotoSlot = {
  slot: 1 | 2 | 3;
  header: string;
  label: string;
  url: string;
};

type Diagnostics = {
  headers: string[];
  headerRowNumber: number;
  dataRowCount: number;
  requiredColumns: Array<{ name: string; found: boolean }>;
  sampleRows: Array<{ rowNumber: number; nonEmptyCellCount: number }>;
};

type CloudinaryDiagnostics = {
  cloudName: string;
  plan: string;
  creditsUsed: number | null;
  creditsLimit: number | null;
  canConnect: boolean;
};

const TOKEN_KEY = "order-photo-manager-token";
const SEARCH_DELAY_MS = 300;
const MAX_PHOTOS_PER_UPLOAD = 3;

function friendlyStatus(status: string): string {
  return status.trim() || "No status";
}

function parsePhotoLinks(photoLink: string): PhotoSlot[] {
  const formulaMatches = Array.from(photoLink.matchAll(/HYPERLINK\("([^"]+)","([^"]+)"\)/g));

  if (formulaMatches.length > 0) {
    return formulaMatches.slice(0, 3).map((match, index) => ({
      slot: (index + 1) as 1 | 2 | 3,
      header: `Photo Link ${index + 1}`,
      label: match[2],
      url: match[1]
    }));
  }

  const urlMatches = Array.from(photoLink.matchAll(/https?:\/\/\S+/g));

  if (urlMatches.length > 0) {
    return urlMatches.slice(0, 3).map((match, index) => {
      const url = match[0];
      const beforeUrl = photoLink.slice(0, match.index).split(/\r?\n|\s+\|\s+/).pop()?.trim();
      const label = beforeUrl && !beforeUrl.startsWith("http") ? beforeUrl.replace(/[:|-]\s*$/, "") : `Photo ${index + 1}`;

      return {
        slot: (index + 1) as 1 | 2 | 3,
        header: `Photo Link ${index + 1}`,
        label,
        url
      };
    });
  }

  return photoLink
    .split(/\r?\n|\s+\|\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line, index) => ({
      slot: (index + 1) as 1 | 2 | 3,
      header: `Photo Link ${index + 1}`,
      label: `Photo ${index + 1}`,
      url: line
    }));
}

function getRowPhotoLinks(row: SearchRow): PhotoSlot[] {
  return row.photoLinks?.length ? row.photoLinks : parsePhotoLinks(row.photoLink);
}

export default function HomePage() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [uploadingRow, setUploadingRow] = useState<number | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [cloudinaryDiagnostics, setCloudinaryDiagnostics] = useState<CloudinaryDiagnostics | null>(null);
  const [isCheckingSheet, setIsCheckingSheet] = useState(false);
  const [isCheckingCloudinary, setIsCheckingCloudinary] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    setToken(window.localStorage.getItem(TOKEN_KEY));
    const splashTimer = window.setTimeout(() => setShowSplash(false), 1800);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => window.clearTimeout(splashTimer);
  }, []);

  const trimmedQuery = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    if (!token) {
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

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
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
    setDiagnostics(null);
    setCloudinaryDiagnostics(null);
  }

  async function handleSheetCheck() {
    if (!token) {
      return;
    }

    setIsCheckingSheet(true);
    setError("");

    try {
      const response = await fetch("/api/diagnostics", {
        headers: {
          "x-app-token": token
        }
      });
      const data = (await response.json()) as Diagnostics & { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Sheet check failed.");
      }

      setDiagnostics(data);
    } catch (checkError) {
      setDiagnostics(null);
      setError((checkError as Error).message);
    } finally {
      setIsCheckingSheet(false);
    }
  }

  async function handleCloudinaryCheck() {
    if (!token) {
      return;
    }

    setIsCheckingCloudinary(true);
    setError("");

    try {
      const response = await fetch("/api/cloudinary-check", {
        headers: {
          "x-app-token": token
        }
      });
      const data = (await response.json()) as CloudinaryDiagnostics & { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Cloudinary check failed.");
      }

      setCloudinaryDiagnostics(data);
    } catch (checkError) {
      setCloudinaryDiagnostics(null);
      setError((checkError as Error).message);
    } finally {
      setIsCheckingCloudinary(false);
    }
  }

  async function handlePhotoChange(row: SearchRow, event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    const files = selectedFiles.slice(0, MAX_PHOTOS_PER_UPLOAD);
    event.target.value = "";

    if (files.length === 0 || !token) {
      return;
    }

    setUploadingRow(row.rowNumber);
    setError(selectedFiles.length > MAX_PHOTOS_PER_UPLOAD ? "Uploading the first 3 selected images." : "");

    try {
      const photos = await Promise.all(files.map((file) => compressImage(file)));
      const response = await fetch("/api/upload-photo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          personalization: row.personalization,
          photos
        })
      });
      const data = (await response.json()) as { success?: boolean; photoLinks?: PhotoSlot[]; error?: string };

      if (!response.ok || !data.success || !data.photoLinks) {
        throw new Error(data.error ?? "Photo upload failed.");
      }

      const uploadedLinks = data.photoLinks;

      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.rowNumber === row.rowNumber
            ? {
                ...currentRow,
                photoLinks: [...getRowPhotoLinks(currentRow).filter((photo) => !uploadedLinks.some((newPhoto) => newPhoto.slot === photo.slot)), ...uploadedLinks].sort(
                  (left, right) => left.slot - right.slot
                ),
                photoLink: [...getRowPhotoLinks(currentRow).filter((photo) => !uploadedLinks.some((newPhoto) => newPhoto.slot === photo.slot)), ...uploadedLinks]
                  .sort((left, right) => left.slot - right.slot)
                  .map((photo) => photo.url)
                  .join("\n")
              }
            : currentRow
        )
      );
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploadingRow(null);
    }
  }

  async function handleDeletePhoto(row: SearchRow, photo: PhotoSlot) {
    if (!token) {
      return;
    }

    const deleteKey = `${row.rowNumber}-${photo.slot}`;
    setDeletingPhoto(deleteKey);
    setError("");

    try {
      const response = await fetch("/api/delete-photo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          slot: photo.slot,
          imageUrl: photo.url
        })
      });
      const data = (await response.json()) as { success?: boolean; error?: string };

      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Photo delete failed.");
      }

      setRows((currentRows) =>
        currentRows.map((currentRow) => {
          if (currentRow.rowNumber !== row.rowNumber) {
            return currentRow;
          }

          const nextLinks = getRowPhotoLinks(currentRow).filter((currentPhoto) => currentPhoto.slot !== photo.slot);

          return {
            ...currentRow,
            photoLinks: nextLinks,
            photoLink: nextLinks.map((currentPhoto) => currentPhoto.url).join("\n")
          };
        })
      );
    } catch (deleteError) {
      setError((deleteError as Error).message);
    } finally {
      setDeletingPhoto(null);
    }
  }

  if (!token) {
    return (
      <main className="app-shell auth-shell">
        {showSplash ? (
          <section className="splash-screen" aria-label="Powered by Nourix Labs">
            <img className="splash-brand-logo" src="/icons/icon-512.png" alt="Big Wood Works" />
            <div className="splash-powered">
              <span>Powered by</span>
              <img src="/brand/nourix-labs.jpeg" alt="Nourix Labs" />
            </div>
          </section>
        ) : null}
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
      {showSplash ? (
        <section className="splash-screen" aria-label="Powered by Nourix Labs">
          <img className="splash-brand-logo" src="/icons/icon-512.png" alt="Big Wood Works" />
          <div className="splash-powered">
            <span>Powered by</span>
            <img src="/brand/nourix-labs.jpeg" alt="Nourix Labs" />
          </div>
        </section>
      ) : null}
      <header className="top-bar">
        <div>
          <p className="eyebrow">Google Sheets + Cloudinary</p>
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
          <span>{`${rows.length} order${rows.length === 1 ? "" : "s"} shown`}</span>
          {isSearching ? <span>Searching...</span> : null}
        </div>
        <button className="secondary-button" type="button" onClick={handleSheetCheck} disabled={isCheckingSheet}>
          {isCheckingSheet ? "Checking Sheet..." : "Sheet Check"}
        </button>
        <button className="secondary-button" type="button" onClick={handleCloudinaryCheck} disabled={isCheckingCloudinary}>
          {isCheckingCloudinary ? "Checking Cloudinary..." : "Cloudinary Check"}
        </button>
      </section>

      {error ? <p className="error-message">{error}</p> : null}

      {diagnostics ? (
        <section className="diagnostics-panel" aria-label="Sheet diagnostics">
          <p>
            <strong>Header row:</strong> {diagnostics.headerRowNumber}
          </p>
          <p>
            <strong>Rows found:</strong> {diagnostics.dataRowCount}
          </p>
          <p>
            <strong>Headers:</strong> {diagnostics.headers.length ? diagnostics.headers.join(", ") : "No headers found"}
          </p>
          <p>
            <strong>Required columns:</strong>{" "}
            {diagnostics.requiredColumns.map((column) => `${column.name}: ${column.found ? "yes" : "no"}`).join(" | ")}
          </p>
        </section>
      ) : null}

      {cloudinaryDiagnostics ? (
        <section className="diagnostics-panel" aria-label="Cloudinary diagnostics">
          <p>
            <strong>Cloudinary cloud:</strong> {cloudinaryDiagnostics.cloudName}
          </p>
          <p>
            <strong>Connected:</strong> {cloudinaryDiagnostics.canConnect ? "yes" : "no"} | <strong>Plan:</strong>{" "}
            {cloudinaryDiagnostics.plan}
          </p>
          {cloudinaryDiagnostics.creditsLimit !== null ? (
            <p>
              <strong>Credits:</strong> {cloudinaryDiagnostics.creditsUsed ?? 0} / {cloudinaryDiagnostics.creditsLimit}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="results-list" aria-live="polite">
        {!isSearching && rows.length === 0 && !error ? (
          <div className="empty-state">
            <h2>{trimmedQuery ? "No matches found" : "No orders found"}</h2>
            <p>{trimmedQuery ? "Try another spelling or a shorter part of the personalization text." : "Check the Sheet tab name and required column headers."}</p>
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

            {getRowPhotoLinks(row).length > 0 ? (
              <div className="photo-links">
                {getRowPhotoLinks(row).map((photo) => (
                  <div className="photo-link-row" key={`${row.rowNumber}-${photo.slot}-${photo.url}`}>
                    <a className="photo-link" href={photo.url} target="_blank" rel="noreferrer">
                      Open Photo {photo.slot}
                      <span>{photo.label}</span>
                    </a>
                    <button
                      className="delete-photo-button"
                      type="button"
                      onClick={() => handleDeletePhoto(row, photo)}
                      disabled={deletingPhoto === `${row.rowNumber}-${photo.slot}` || uploadingRow !== null}
                    >
                      {deletingPhoto === `${row.rowNumber}-${photo.slot}` ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No photo link yet</p>
            )}

            <label className={`file-button ${uploadingRow === row.rowNumber ? "is-loading" : ""}`}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                disabled={uploadingRow !== null}
                onChange={(event) => handlePhotoChange(row, event)}
              />
              {uploadingRow === row.rowNumber ? "Uploading..." : "Add Photos"}
            </label>
          </article>
        ))}
      </section>
    </main>
  );
}

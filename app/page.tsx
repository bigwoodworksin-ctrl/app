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

type SheetProfile = {
  id: string;
  name: string;
  sheetId: string;
  tabName: string;
};

type ShippingRow = {
  rowNumber: number;
  trackingId: string;
  status: string;
  personalization: string;
  dispatchPhotoLink: string;
};

const TOKEN_KEY = "order-photo-manager-token";
const SHEET_PROFILES_KEY = "order-photo-manager-sheet-profiles";
const ACTIVE_PROFILE_KEY = "order-photo-manager-active-profile";
const SEARCH_DELAY_MS = 300;
const MAX_PHOTOS_PER_UPLOAD = 3;
const SHIPPING_STATUSES = ["Packed", "Dispatched", "Delivered", "Shipment On Hold", "In Transit", "Failed", "Clearance Event"];

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
  const [activeView, setActiveView] = useState<"photos" | "shipping" | "settings">("photos");
  const [sheetProfiles, setSheetProfiles] = useState<SheetProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [newSheetName, setNewSheetName] = useState("");
  const [newSheetUrl, setNewSheetUrl] = useState("");
  const [newSheetTab, setNewSheetTab] = useState("");
  const [tabs, setTabs] = useState<Array<{ title: string; sheetId: number }>>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [trackingInput, setTrackingInput] = useState("");
  const [shippingRow, setShippingRow] = useState<ShippingRow | null>(null);
  const [isSearchingTracking, setIsSearchingTracking] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isUploadingDispatch, setIsUploadingDispatch] = useState(false);
  const [scanMessage, setScanMessage] = useState("");

  useEffect(() => {
    setToken(window.localStorage.getItem(TOKEN_KEY));
    const storedProfiles = window.localStorage.getItem(SHEET_PROFILES_KEY);
    const defaultProfile: SheetProfile = {
      id: "default",
      name: "Default Sheet",
      sheetId: "",
      tabName: ""
    };
    let parsedProfiles = [defaultProfile];

    try {
      parsedProfiles = storedProfiles ? (JSON.parse(storedProfiles) as SheetProfile[]) : [defaultProfile];
    } catch {
      parsedProfiles = [defaultProfile];
    }
    const safeProfiles = parsedProfiles.length > 0 ? parsedProfiles : [defaultProfile];

    setSheetProfiles(safeProfiles);
    setActiveProfileId(window.localStorage.getItem(ACTIVE_PROFILE_KEY) || safeProfiles[0].id);
    const splashTimer = window.setTimeout(() => setShowSplash(false), 1800);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => window.clearTimeout(splashTimer);
  }, []);

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const activeProfile = sheetProfiles.find((profile) => profile.id === activeProfileId) ?? sheetProfiles[0];
  const selectedTarget = {
    sheetId: activeProfile?.sheetId ?? "",
    tabName: activeProfile?.tabName ?? ""
  };
  const targetQuery = new URLSearchParams();

  if (selectedTarget.sheetId) {
    targetQuery.set("sheetId", selectedTarget.sheetId);
  }

  if (selectedTarget.tabName) {
    targetQuery.set("tabName", selectedTarget.tabName);
  }

  function targetUrl(path: string, extra?: Record<string, string>) {
    const params = new URLSearchParams(targetQuery);

    for (const [key, value] of Object.entries(extra ?? {})) {
      params.set(key, value);
    }

    return `${path}?${params.toString()}`;
  }

  function targetBody<T extends object>(body: T): T & { sheetId?: string; tabName?: string } {
    return {
      ...body,
      sheetId: selectedTarget.sheetId || undefined,
      tabName: selectedTarget.tabName || undefined
    };
  }

  function saveProfiles(nextProfiles: SheetProfile[], nextActiveId = activeProfileId) {
    setSheetProfiles(nextProfiles);
    setActiveProfileId(nextActiveId);
    window.localStorage.setItem(SHEET_PROFILES_KEY, JSON.stringify(nextProfiles));
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, nextActiveId);
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setError("");

      try {
        const response = await fetch(targetUrl("/api/search", { q: trimmedQuery }), {
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
  }, [token, trimmedQuery, activeProfileId, activeProfile?.sheetId, activeProfile?.tabName]);

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

  async function handleLoadTabs() {
    if (!token || !activeProfile) {
      return;
    }

    setIsLoadingTabs(true);
    setError("");

    try {
      const response = await fetch(targetUrl("/api/tabs"), {
        headers: {
          "x-app-token": token
        }
      });
      const data = (await response.json()) as { tabs?: Array<{ title: string; sheetId: number }>; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load tabs.");
      }

      setTabs(data.tabs ?? []);
    } catch (tabError) {
      setTabs([]);
      setError((tabError as Error).message);
    } finally {
      setIsLoadingTabs(false);
    }
  }

  function handleAddSheetProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!newSheetName.trim() || !newSheetUrl.trim() || !newSheetTab.trim()) {
      setError("Add a sheet name, Sheet URL, and month/tab name.");
      return;
    }

    const nextProfile: SheetProfile = {
      id: `${Date.now()}`,
      name: newSheetName.trim(),
      sheetId: newSheetUrl.trim(),
      tabName: newSheetTab.trim()
    };
    const nextProfiles = [...sheetProfiles, nextProfile];

    saveProfiles(nextProfiles, nextProfile.id);
    setNewSheetName("");
    setNewSheetUrl("");
    setNewSheetTab("");
    setTabs([]);
    setError("");
  }

  function handleProfileChange(profileId: string) {
    setActiveProfileId(profileId);
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
    setRows([]);
    setShippingRow(null);
    setTabs([]);
    setError("");
  }

  function handleTabChange(tabName: string) {
    if (!activeProfile) {
      return;
    }

    const nextProfiles = sheetProfiles.map((profile) =>
      profile.id === activeProfile.id ? { ...profile, tabName } : profile
    );

    saveProfiles(nextProfiles, activeProfile.id);
    setRows([]);
    setShippingRow(null);
  }

  async function handleSheetCheck() {
    if (!token) {
      return;
    }

    setIsCheckingSheet(true);
    setError("");

    try {
      const response = await fetch(targetUrl("/api/diagnostics"), {
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
        body: JSON.stringify(
          targetBody({
            rowNumber: row.rowNumber,
            personalization: row.personalization,
            photos
          })
        )
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
        body: JSON.stringify(
          targetBody({
            rowNumber: row.rowNumber,
            slot: photo.slot,
            imageUrl: photo.url
          })
        )
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

  async function handleTrackingSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!token || !trackingInput.trim()) {
      return;
    }

    setIsSearchingTracking(true);
    setError("");
    setShippingRow(null);

    try {
      const response = await fetch(targetUrl("/api/shipping/search", { trackingId: trackingInput.trim() }), {
        headers: {
          "x-app-token": token
        }
      });
      const data = (await response.json()) as { row?: ShippingRow | null; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Tracking search failed.");
      }

      if (!data.row) {
        throw new Error("No row found for that tracking ID.");
      }

      setShippingRow(data.row);
    } catch (trackingError) {
      setError((trackingError as Error).message);
    } finally {
      setIsSearchingTracking(false);
    }
  }

  async function handleStatusUpdate(status: string) {
    if (!token || !shippingRow) {
      return;
    }

    setIsUpdatingStatus(true);
    setError("");

    try {
      const response = await fetch("/api/shipping/status", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify(
          targetBody({
            rowNumber: shippingRow.rowNumber,
            status
          })
        )
      });
      const data = (await response.json()) as { success?: boolean; error?: string };

      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Status update failed.");
      }

      setShippingRow({ ...shippingRow, status });
    } catch (statusError) {
      setError((statusError as Error).message);
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  async function handleDispatchPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!token || !shippingRow || !file) {
      return;
    }

    setIsUploadingDispatch(true);
    setError("");

    try {
      const compressed = await compressImage(file);
      const response = await fetch("/api/shipping/dispatch-photo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify(
          targetBody({
            rowNumber: shippingRow.rowNumber,
            trackingId: shippingRow.trackingId,
            ...compressed
          })
        )
      });
      const data = (await response.json()) as { success?: boolean; imageUrl?: string; error?: string };

      if (!response.ok || !data.success || !data.imageUrl) {
        throw new Error(data.error ?? "Dispatch photo upload failed.");
      }

      setShippingRow({ ...shippingRow, dispatchPhotoLink: data.imageUrl });
    } catch (dispatchError) {
      setError((dispatchError as Error).message);
    } finally {
      setIsUploadingDispatch(false);
    }
  }

  async function handleBarcodeImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setScanMessage("");

    try {
      const BarcodeDetectorClass = (window as unknown as {
        BarcodeDetector?: new (options?: { formats?: string[] }) => {
          detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
        };
      }).BarcodeDetector;

      if (!BarcodeDetectorClass) {
        throw new Error("Barcode scanning is not supported in this browser. Type the tracking ID manually.");
      }

      const detector = new BarcodeDetectorClass({
        formats: ["code_128", "code_39", "ean_13", "qr_code", "upc_a", "upc_e"]
      });
      const bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      const rawValue = codes[0]?.rawValue ?? "";

      if (!rawValue) {
        throw new Error("No barcode found. Try a clearer photo or enter the tracking ID manually.");
      }

      setTrackingInput(rawValue);
      setScanMessage(`Scanned: ${rawValue}`);
    } catch (scanError) {
      setScanMessage((scanError as Error).message);
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
      <header className="top-bar app-title-bar">
        <div>
          <h1>
            {activeView === "photos"
              ? "Order Photos"
              : activeView === "shipping"
                ? "Shipping Status"
                : "Sheet Settings"}
          </h1>
        </div>
        <button className="ghost-button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      {activeView !== "settings" ? (
        <section className="sheet-strip" aria-label="Current sheet and month tab">
          <div className="sheet-strip-name">
            <span>Current sheet</span>
            <strong>{activeProfile?.name ?? "Default Sheet"}</strong>
          </div>
          <div className="sheet-strip-tab">
            <label htmlFor="sheet-tab">Month / tab</label>
            <select
              id="sheet-tab"
              value={activeProfile?.tabName ?? ""}
              onChange={(event) => handleTabChange(event.target.value)}
            >
              <option value={activeProfile?.tabName ?? ""}>{activeProfile?.tabName || "Select tab"}</option>
              {tabs.map((tab) => (
                <option value={tab.title} key={tab.sheetId}>
                  {tab.title}
                </option>
              ))}
            </select>
            <button className="secondary-button compact" type="button" onClick={handleLoadTabs} disabled={isLoadingTabs}>
              {isLoadingTabs ? "Loading..." : "Tabs"}
            </button>
          </div>
        </section>
      ) : null}

      {activeView === "photos" ? (
        <>
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
        </>
      ) : activeView === "shipping" ? (
        <section className="shipping-panel" aria-label="Shipping status manager">
          <form className="tracking-form" onSubmit={handleTrackingSearch}>
            <label htmlFor="tracking-id">Tracking ID</label>
            <input
              id="tracking-id"
              value={trackingInput}
              onChange={(event) => setTrackingInput(event.target.value)}
              placeholder="Scan or type tracking ID"
            />
            <div className="shipping-actions">
              <button className="primary-button" disabled={isSearchingTracking || !trackingInput.trim()}>
                {isSearchingTracking ? "Searching..." : "Find Tracking"}
              </button>
              <label className="secondary-button scan-button">
                Scan Barcode
                <input type="file" accept="image/*" capture="environment" onChange={handleBarcodeImage} />
              </label>
            </div>
            {scanMessage ? <p className="muted">{scanMessage}</p> : null}
          </form>

          {shippingRow ? (
            <article className="result-card">
              <div className="card-head">
                <span className="row-number">Row {shippingRow.rowNumber}</span>
                <span className="status-badge status-active">{shippingRow.status || "No status"}</span>
              </div>
              <p className="personalization">{shippingRow.personalization || shippingRow.trackingId}</p>
              <p className="muted">Tracking: {shippingRow.trackingId}</p>
              <div className="field-row">
                <label htmlFor="shipping-status">Carrier / Status</label>
                <select
                  id="shipping-status"
                  value={shippingRow.status || ""}
                  disabled={isUpdatingStatus}
                  onChange={(event) => handleStatusUpdate(event.target.value)}
                >
                  <option value="">Choose status</option>
                  {SHIPPING_STATUSES.map((status) => (
                    <option value={status} key={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              {shippingRow.dispatchPhotoLink ? (
                <a className="photo-link dispatch-link" href={shippingRow.dispatchPhotoLink} target="_blank" rel="noreferrer">
                  Open Dispatch Photo
                </a>
              ) : (
                <p className="muted">No dispatch photo yet</p>
              )}
              <label className={`file-button ${isUploadingDispatch ? "is-loading" : ""}`}>
                <input type="file" accept="image/*" capture="environment" disabled={isUploadingDispatch} onChange={handleDispatchPhoto} />
                {isUploadingDispatch ? "Uploading..." : "Upload Dispatch Photo"}
              </label>
            </article>
          ) : null}
        </section>
      ) : (
        <section className="settings-panel" aria-label="Sheet settings">
          <div className="field-row">
            <label htmlFor="settings-sheet-profile">Active sheet</label>
            <select id="settings-sheet-profile" value={activeProfileId} onChange={(event) => handleProfileChange(event.target.value)}>
              {sheetProfiles.map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label htmlFor="settings-tab">Month / tab</label>
            <div className="inline-controls">
              <input
                id="settings-tab"
                value={activeProfile?.tabName ?? ""}
                onChange={(event) => handleTabChange(event.target.value)}
                placeholder="Sheet1 or May 2026"
              />
              <button className="secondary-button compact" type="button" onClick={handleLoadTabs} disabled={isLoadingTabs}>
                {isLoadingTabs ? "Loading..." : "Load"}
              </button>
            </div>
          </div>
          <form className="add-sheet-form" onSubmit={handleAddSheetProfile}>
            <label>Add new sheet</label>
            <input value={newSheetName} onChange={(event) => setNewSheetName(event.target.value)} placeholder="Name" />
            <input value={newSheetUrl} onChange={(event) => setNewSheetUrl(event.target.value)} placeholder="Paste Google Sheet URL" />
            <input value={newSheetTab} onChange={(event) => setNewSheetTab(event.target.value)} placeholder="Month/tab name" />
            <button className="primary-button" type="submit">
              Add Sheet
            </button>
          </form>
          <button className="secondary-button" type="button" onClick={handleSheetCheck} disabled={isCheckingSheet}>
            {isCheckingSheet ? "Checking Sheet..." : "Sheet Check"}
          </button>
          <button className="secondary-button" type="button" onClick={handleCloudinaryCheck} disabled={isCheckingCloudinary}>
            {isCheckingCloudinary ? "Checking Cloudinary..." : "Cloudinary Check"}
          </button>
        </section>
      )}

      <nav className="bottom-nav" aria-label="Main navigation">
        <button className={activeView === "photos" ? "is-active" : ""} type="button" onClick={() => setActiveView("photos")}>
          <span aria-hidden="true">P</span>
          <small>Photos</small>
        </button>
        <button className={activeView === "shipping" ? "is-active" : ""} type="button" onClick={() => setActiveView("shipping")}>
          <span aria-hidden="true">S</span>
          <small>Shipping</small>
        </button>
        <button className={activeView === "settings" ? "is-active" : ""} type="button" onClick={() => setActiveView("settings")}>
          <span aria-hidden="true">*</span>
          <small>Settings</small>
        </button>
      </nav>
    </main>
  );
}

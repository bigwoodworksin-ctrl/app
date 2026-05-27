"use client";

import type { ChangeEvent } from "react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compressImage } from "@/lib/image";

type BarcodeDetectorInstance = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

type SearchRow = {
  rowNumber: number;
  photoLink: string;
  photoLinks: PhotoSlot[];
  status: string;
  personalization: string;
  priority: 1 | 2;
  sheetId?: string;
  tabName?: string;
  sheetName?: string;
};

type PhotoSlot = {
  slot: 1 | 2 | 3;
  header: string;
  label: string;
  url: string;
};

type UploadProgress = {
  id: string;
  label: string;
  error?: string;
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

type SheetTab = {
  title: string;
  sheetId: number;
};

type SheetProfile = {
  id: string;
  name: string;
  sheetId: string;
  tabName: string;
  tabs?: SheetTab[];
};

type ShippingRow = {
  rowNumber: number;
  trackingId: string;
  status: string;
  personalization: string;
  dispatchPhotoLink: string;
  sheetId?: string;
  tabName?: string;
  sheetName?: string;
};

const TOKEN_KEY = "order-photo-manager-token";
const SHEET_PROFILES_KEY = "order-photo-manager-sheet-profiles";
const ACTIVE_PROFILE_KEY = "order-photo-manager-active-profile";
const ACTIVE_PROFILE_IDS_KEY = "order-photo-manager-active-profile-ids";
const SEARCH_DELAY_MS = 300;
const MAX_PHOTOS_PER_UPLOAD = 3;
const SHIPPING_STATUSES = ["New", "Packed", "Dispatched", "Delivered", "Shipment On Hold", "In Transit", "Failed", "Clearance Event"];

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

function rowUploadKey(row: SearchRow): string {
  return `${row.sheetId ?? "default"}:${row.tabName ?? "default"}:${row.rowNumber}`;
}

export default function HomePage() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [uploadingRow, setUploadingRow] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState<Record<string, UploadProgress[]>>({});
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
  const [activeProfileIds, setActiveProfileIds] = useState<string[]>([]);
  const [newSheetName, setNewSheetName] = useState("");
  const [newSheetUrl, setNewSheetUrl] = useState("");
  const [newSheetTab, setNewSheetTab] = useState("");
  const [newSheetTabs, setNewSheetTabs] = useState<SheetTab[]>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [isFetchingNewSheet, setIsFetchingNewSheet] = useState(false);
  const [trackingInput, setTrackingInput] = useState("");
  const [shippingRow, setShippingRow] = useState<ShippingRow | null>(null);
  const [isSearchingTracking, setIsSearchingTracking] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isUploadingDispatch, setIsUploadingDispatch] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [isLiveScanning, setIsLiveScanning] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerFrameRef = useRef<number | null>(null);
  const scannerBusyRef = useRef(false);

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
    const safeProfiles = (parsedProfiles.length > 0 ? parsedProfiles : [defaultProfile]).map((profile) => ({
      ...profile,
      tabs: profile.tabs ?? []
    }));

    setSheetProfiles(safeProfiles);
    const storedActiveId = window.localStorage.getItem(ACTIVE_PROFILE_KEY) || safeProfiles[0].id;
    let storedActiveIds = [storedActiveId];

    try {
      const parsedActiveIds = JSON.parse(window.localStorage.getItem(ACTIVE_PROFILE_IDS_KEY) ?? "[]") as string[];
      storedActiveIds = parsedActiveIds.length ? parsedActiveIds : [storedActiveId];
    } catch {
      storedActiveIds = [storedActiveId];
    }

    const safeActiveIds = storedActiveIds.filter((profileId) => safeProfiles.some((profile) => profile.id === profileId));

    setActiveProfileId(safeProfiles.some((profile) => profile.id === storedActiveId) ? storedActiveId : safeProfiles[0].id);
    setActiveProfileIds(safeActiveIds.length ? safeActiveIds : [safeProfiles[0].id]);
    const splashTimer = window.setTimeout(() => setShowSplash(false), 1800);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => window.clearTimeout(splashTimer);
  }, []);

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const activeProfile = sheetProfiles.find((profile) => profile.id === activeProfileId) ?? sheetProfiles[0];
  const activeProfileTabs = activeProfile?.tabs ?? [];
  const searchProfiles = sheetProfiles.filter((profile) => activeProfileIds.includes(profile.id));
  const activeSearchProfiles = searchProfiles.length ? searchProfiles : activeProfile ? [activeProfile] : [];
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

  function searchUrl(path: string, extra?: Record<string, string>) {
    const params = new URLSearchParams();
    const targets = activeSearchProfiles.map((profile) => ({
      sheetId: profile.sheetId || undefined,
      tabName: profile.tabName || undefined,
      sheetName: profile.name
    }));

    for (const [key, value] of Object.entries(extra ?? {})) {
      params.set(key, value);
    }

    if (targets.length > 0) {
      params.set("targets", JSON.stringify(targets));
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

  function rowTargetBody<T extends object>(row: SearchRow, body: T): T & { sheetId?: string; tabName?: string } {
    return {
      ...body,
      sheetId: row.sheetId || selectedTarget.sheetId || undefined,
      tabName: row.tabName || selectedTarget.tabName || undefined
    };
  }

  function saveProfiles(nextProfiles: SheetProfile[], nextActiveId = activeProfileId, ensureActive = true) {
    setSheetProfiles(nextProfiles);
    setActiveProfileId(nextActiveId);
    setActiveProfileIds((currentIds) => {
      const nextIds = currentIds.filter((profileId) => nextProfiles.some((profile) => profile.id === profileId));
      const finalIds = ensureActive && !nextIds.includes(nextActiveId) ? [...nextIds, nextActiveId] : nextIds;
      const safeFinalIds = finalIds.length ? finalIds : [nextActiveId];

      window.localStorage.setItem(ACTIVE_PROFILE_IDS_KEY, JSON.stringify(safeFinalIds));
      return safeFinalIds;
    });
    window.localStorage.setItem(SHEET_PROFILES_KEY, JSON.stringify(nextProfiles));
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, nextActiveId);
  }

  const fetchSheetInfo = useCallback(async (sheetUrl: string, signal?: AbortSignal) => {
    if (!token) {
      throw new Error("Unlock the app first.");
    }

    const params = new URLSearchParams({ sheetId: sheetUrl.trim() });
    const response = await fetch(`/api/tabs?${params.toString()}`, {
      headers: {
        "x-app-token": token
      },
      signal
    });
    const data = (await response.json()) as { spreadsheetTitle?: string; tabs?: SheetTab[]; error?: string };

    if (!response.ok) {
      throw new Error(data.error ?? "Could not fetch Sheet details.");
    }

    return {
      spreadsheetTitle: data.spreadsheetTitle?.trim() || "Google Sheet",
      tabs: data.tabs ?? []
    };
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setError("");

      try {
        const response = await fetch(searchUrl("/api/search", { q: trimmedQuery }), {
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
  }, [token, trimmedQuery, activeProfileId, activeProfileIds, activeProfile?.sheetId, activeProfile?.tabName, sheetProfiles]);

  useEffect(() => {
    const sheetUrl = newSheetUrl.trim();
    const looksLikeSheet = sheetUrl.includes("/spreadsheets/d/") || /^[a-zA-Z0-9-_]{20,}$/.test(sheetUrl);

    if (!token || !sheetUrl || !looksLikeSheet) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsFetchingNewSheet(true);

      try {
        const metadata = await fetchSheetInfo(sheetUrl, controller.signal);
        setNewSheetName(metadata.spreadsheetTitle);
        setNewSheetTabs(metadata.tabs);
        setNewSheetTab((currentTab) =>
          currentTab && metadata.tabs.some((tab) => tab.title === currentTab) ? currentTab : metadata.tabs[0]?.title ?? ""
        );
        setError("");
      } catch (sheetError) {
        if ((sheetError as Error).name !== "AbortError") {
          setNewSheetTabs([]);
          setError((sheetError as Error).message);
        }
      } finally {
        setIsFetchingNewSheet(false);
      }
    }, 700);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [token, newSheetUrl, fetchSheetInfo]);

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
    stopLiveScanner();
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
      const data = (await response.json()) as { spreadsheetTitle?: string; tabs?: SheetTab[]; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load tabs.");
      }

      const nextTabs = data.tabs ?? [];
      const nextTabName =
        activeProfile.tabName && nextTabs.some((tab) => tab.title === activeProfile.tabName)
          ? activeProfile.tabName
          : nextTabs[0]?.title ?? activeProfile.tabName;
      const nextProfiles = sheetProfiles.map((profile) =>
        profile.id === activeProfile.id
          ? {
              ...profile,
              name: data.spreadsheetTitle?.trim() || profile.name,
              tabName: nextTabName,
              tabs: nextTabs
            }
          : profile
      );

      saveProfiles(nextProfiles, activeProfile.id);
    } catch (tabError) {
      setError((tabError as Error).message);
    } finally {
      setIsLoadingTabs(false);
    }
  }

  async function handleFetchNewSheetInfo() {
    if (!token || !newSheetUrl.trim()) {
      setError("Paste a Google Sheet URL first.");
      return;
    }

    setIsFetchingNewSheet(true);
    setError("");

    try {
      const metadata = await fetchSheetInfo(newSheetUrl);
      const nextTabs = metadata.tabs;
      setNewSheetName(metadata.spreadsheetTitle);
      setNewSheetTabs(nextTabs);
      setNewSheetTab(nextTabs[0]?.title ?? "");
    } catch (sheetError) {
      setNewSheetTabs([]);
      setError((sheetError as Error).message);
    } finally {
      setIsFetchingNewSheet(false);
    }
  }

  function handleAddSheetProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!newSheetUrl.trim() || !newSheetTab.trim()) {
      setError("Add a Sheet URL and choose a month/tab.");
      return;
    }

    const nextProfile: SheetProfile = {
      id: `${Date.now()}`,
      name: newSheetName.trim() || "Google Sheet",
      sheetId: newSheetUrl.trim(),
      tabName: newSheetTab.trim(),
      tabs: newSheetTabs
    };
    const nextProfiles = [...sheetProfiles, nextProfile];

    saveProfiles(nextProfiles, nextProfile.id);
    setNewSheetName("");
    setNewSheetUrl("");
    setNewSheetTab("");
    setNewSheetTabs([]);
    setError("");
  }

  function handleProfileChange(profileId: string) {
    setActiveProfileId(profileId);
    setActiveProfileIds((currentIds) => {
      const nextIds = currentIds.includes(profileId) ? currentIds : [...currentIds, profileId];

      window.localStorage.setItem(ACTIVE_PROFILE_IDS_KEY, JSON.stringify(nextIds));
      return nextIds;
    });
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
    setRows([]);
    setShippingRow(null);
    setError("");
  }

  function handleProfileEnabled(profileId: string, enabled: boolean) {
    const nextIds = enabled
      ? [...new Set([...activeProfileIds, profileId])]
      : activeProfileIds.filter((currentId) => currentId !== profileId);
    const finalIds = nextIds.length ? nextIds : [profileId];
    const nextFocusedProfileId = finalIds.includes(activeProfileId) ? activeProfileId : finalIds[0];

    setActiveProfileIds(finalIds);
    setActiveProfileId(nextFocusedProfileId);
    window.localStorage.setItem(ACTIVE_PROFILE_IDS_KEY, JSON.stringify(finalIds));
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, nextFocusedProfileId);
    setRows([]);
    setShippingRow(null);
    setError("");
  }

  function handleDeleteSheetProfile(profileId: string) {
    if (sheetProfiles.length <= 1) {
      setError("Keep at least one sheet profile.");
      return;
    }

    const nextProfiles = sheetProfiles.filter((profile) => profile.id !== profileId);
    const nextActiveId = activeProfileId === profileId ? nextProfiles[0].id : activeProfileId;
    const nextActiveIds = activeProfileIds.filter((currentId) => currentId !== profileId);
    const finalActiveIds = nextActiveIds.length ? nextActiveIds : [nextActiveId];

    setSheetProfiles(nextProfiles);
    setActiveProfileId(nextActiveId);
    setActiveProfileIds(finalActiveIds);
    window.localStorage.setItem(SHEET_PROFILES_KEY, JSON.stringify(nextProfiles));
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, nextActiveId);
    window.localStorage.setItem(ACTIVE_PROFILE_IDS_KEY, JSON.stringify(finalActiveIds));
    setRows([]);
    setShippingRow(null);
    setError("");
  }

  function handleTabChange(tabName: string) {
    if (!activeProfile) {
      return;
    }

    handleProfileTabChange(activeProfile.id, tabName);
  }

  function handleProfileTabChange(profileId: string, tabName: string, ensureActive = activeProfileIds.includes(profileId)) {
    const nextProfiles = sheetProfiles.map((profile) =>
      profile.id === profileId ? { ...profile, tabName } : profile
    );

    saveProfiles(nextProfiles, profileId, ensureActive);
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

    const key = rowUploadKey(row);
    const startNumber = getRowPhotoLinks(row).length + 1;
    const progressItems = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      label: `Photo ${startNumber + index} uploading...`
    }));

    setUploadingPhotos((currentUploads) => ({
      ...currentUploads,
      [key]: [...(currentUploads[key] ?? []), ...progressItems]
    }));
    setUploadingRow(key);
    setError(selectedFiles.length > MAX_PHOTOS_PER_UPLOAD ? "Uploading the first 3 selected images." : "");

    try {
      for (const [fileIndex, file] of files.entries()) {
        const photo = await compressImage(file);
      const response = await fetch("/api/upload-photo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app-token": token
        },
        body: JSON.stringify(
          rowTargetBody(row, {
            rowNumber: row.rowNumber,
            personalization: row.personalization,
              photos: [photo]
          })
        )
      });
        const responseText = await response.text();
        let data: { success?: boolean; photoLinks?: PhotoSlot[]; error?: string };

        try {
          data = JSON.parse(responseText) as { success?: boolean; photoLinks?: PhotoSlot[]; error?: string };
        } catch {
          throw new Error(responseText || `Photo upload failed with status ${response.status}.`);
        }

      if (!response.ok || !data.success || !data.photoLinks) {
        throw new Error(data.error ?? "Photo upload failed.");
      }

      const uploadedLinks = data.photoLinks;

      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          rowUploadKey(currentRow) === key
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

        setUploadingPhotos((currentUploads) => ({
          ...currentUploads,
          [key]: (currentUploads[key] ?? []).map((item) =>
            item.id === progressItems[fileIndex]?.id ? { ...item, label: item.label.replace("uploading...", "uploaded") } : item
          )
        }));
      }
    } catch (uploadError) {
      const message = (uploadError as Error).message;

      setError(message);
      setUploadingPhotos((currentUploads) => ({
        ...currentUploads,
        [key]: (currentUploads[key] ?? []).map((item) =>
          progressItems.some((progressItem) => progressItem.id === item.id)
            ? { ...item, label: `${item.label.replace("uploading...", "failed")}: ${message}`, error: message }
            : item
        )
      }));
      return;
    } finally {
      setUploadingRow(null);
    }

    setUploadingPhotos((currentUploads) => {
      const remainingUploads = (currentUploads[key] ?? []).filter(
        (item) => !progressItems.some((progressItem) => progressItem.id === item.id)
      );
      const nextUploads = { ...currentUploads };

      if (remainingUploads.length) {
        nextUploads[key] = remainingUploads;
      } else {
        delete nextUploads[key];
      }

      return nextUploads;
    });
  }

  async function handleDeletePhoto(row: SearchRow, photo: PhotoSlot) {
    if (!token) {
      return;
    }

    const deleteKey = `${rowUploadKey(row)}-${photo.slot}`;
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
          rowTargetBody(row, {
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
          if (rowUploadKey(currentRow) !== rowUploadKey(row)) {
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

  async function searchTrackingId(trackingId: string) {
    if (!token || !trackingId.trim()) {
      return;
    }

    setIsSearchingTracking(true);
    setError("");
    setShippingRow(null);

    try {
      const response = await fetch(searchUrl("/api/shipping/search", { trackingId: trackingId.trim() }), {
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

  async function handleTrackingSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    await searchTrackingId(trackingInput);
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
          {
            rowNumber: shippingRow.rowNumber,
            status,
            sheetId: shippingRow.sheetId || selectedTarget.sheetId || undefined,
            tabName: shippingRow.tabName || selectedTarget.tabName || undefined
          }
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
          {
            rowNumber: shippingRow.rowNumber,
            trackingId: shippingRow.trackingId,
            sheetId: shippingRow.sheetId || selectedTarget.sheetId || undefined,
            tabName: shippingRow.tabName || selectedTarget.tabName || undefined,
            ...compressed
          }
        )
      });
      const data = (await response.json()) as { success?: boolean; imageUrl?: string; error?: string };

      if (!response.ok || !data.success || !data.imageUrl) {
        throw new Error(data.error ?? "Dispatch photo upload failed.");
      }

      setShippingRow({ ...shippingRow, dispatchPhotoLink: data.imageUrl, status: "Packed" });
    } catch (dispatchError) {
      setError((dispatchError as Error).message);
    } finally {
      setIsUploadingDispatch(false);
    }
  }

  function stopLiveScanner() {
    if (scannerFrameRef.current !== null) {
      window.cancelAnimationFrame(scannerFrameRef.current);
      scannerFrameRef.current = null;
    }

    scannerStreamRef.current?.getTracks().forEach((track) => track.stop());
    scannerStreamRef.current = null;
    scannerBusyRef.current = false;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsLiveScanning(false);
  }

  function scanVideoFrame(detector: BarcodeDetectorInstance) {
    const video = videoRef.current;

    if (!video || !scannerStreamRef.current) {
      return;
    }

    const scanNextFrame = () => {
      if (!scannerStreamRef.current) {
        return;
      }

      scannerFrameRef.current = window.requestAnimationFrame(() => scanVideoFrame(detector));
    };

    if (scannerBusyRef.current || video.readyState < 4) {
      scanNextFrame();
      return;
    }

    scannerBusyRef.current = true;
    detector
      .detect(video)
      .then((codes) => {
        const rawValue = codes[0]?.rawValue?.trim() ?? "";

        if (rawValue) {
          setTrackingInput(rawValue);
          setScanMessage(`Scanned: ${rawValue}`);
          stopLiveScanner();
          void searchTrackingId(rawValue);
          return;
        }

        scanNextFrame();
      })
      .catch(() => {
        scanNextFrame();
      })
      .finally(() => {
        scannerBusyRef.current = false;
      });
  }

  async function startLiveScanner() {
    setScannerError("");
    setScanMessage("");

    try {
      const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;

      if (!BarcodeDetectorClass) {
        throw new Error("Live barcode scanning is not supported in this browser. Use Chrome on Android or type the tracking ID manually.");
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not available in this browser.");
      }

      stopLiveScanner();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" }
        }
      });
      const video = videoRef.current;

      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      scannerStreamRef.current = stream;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play();
      setIsLiveScanning(true);
      scanVideoFrame(
        new BarcodeDetectorClass({
          formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code", "upc_a", "upc_e"]
        })
      );
    } catch (scanError) {
      stopLiveScanner();
      setScannerError((scanError as Error).message);
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

  useEffect(() => {
    if (!token || activeView !== "shipping") {
      stopLiveScanner();
      return;
    }

    const timer = window.setTimeout(() => {
      void startLiveScanner();
    }, 350);

    return () => {
      window.clearTimeout(timer);
      stopLiveScanner();
    };
    // The scanner functions intentionally use the latest camera refs and selected sheet state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeView]);

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
            <img className="sheet-strip-icon" src="/icons/spreadsheet.svg" alt="" aria-hidden="true" />
            <span>Active sheets</span>
            <strong>{activeSearchProfiles.map((profile) => profile.name).join(", ") || "Default Sheet"}</strong>
          </div>
          <div className="sheet-strip-name sheet-strip-current-tab">
            <img className="sheet-strip-icon" src="/icons/spreadsheet.svg" alt="" aria-hidden="true" />
            <span>Selected tabs</span>
            <strong>{activeSearchProfiles.map((profile) => profile.tabName || "No tab").join(", ") || "No tab selected"}</strong>
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
          <article className="result-card" key={rowUploadKey(row)}>
            <div className="card-head">
              <span className="row-number">Row {row.rowNumber}</span>
              <span className={`status-badge ${row.priority === 2 ? "status-done" : "status-active"}`}>
                {friendlyStatus(row.status)}
              </span>
            </div>
            {row.sheetName || row.tabName ? (
              <p className="muted source-line">
                {[row.sheetName, row.tabName].filter(Boolean).join(" / ")}
              </p>
            ) : null}

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
                      disabled={deletingPhoto === `${rowUploadKey(row)}-${photo.slot}`}
                    >
                      {deletingPhoto === `${rowUploadKey(row)}-${photo.slot}` ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No photo link yet</p>
            )}

            {(uploadingPhotos[rowUploadKey(row)] ?? []).length > 0 ? (
              <div className="upload-progress-list" aria-live="polite">
                {(uploadingPhotos[rowUploadKey(row)] ?? []).map((item) => (
                  <div className={`upload-progress-line ${item.error ? "is-error" : ""}`} key={item.id}>
                    {item.label}
                  </div>
                ))}
              </div>
            ) : null}

            <label className="file-button">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                disabled={uploadingRow === rowUploadKey(row)}
                onChange={(event) => handlePhotoChange(row, event)}
              />
              Add Photo
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
              <button className="secondary-button scan-button" type="button" onClick={isLiveScanning ? stopLiveScanner : startLiveScanner}>
                {isLiveScanning ? "Stop Scan" : "Scan Barcode"}
              </button>
            </div>
            {scanMessage ? <p className="muted">{scanMessage}</p> : null}
          </form>

          <div className={`live-scanner ${isLiveScanning ? "is-scanning" : ""}`} aria-label="Live barcode scanner">
            <video ref={videoRef} muted playsInline autoPlay />
            <div className="scan-frame" aria-hidden="true" />
            <p>{isLiveScanning ? "Place barcode inside the rectangle" : "Camera scanner"}</p>
          </div>
          {scannerError ? <p className="error-message">{scannerError}</p> : null}

          {error ? <p className="error-message">{error}</p> : null}

          {shippingRow ? (
            <article className="result-card">
              <div className="card-head">
                <span className="row-number">Row {shippingRow.rowNumber}</span>
                <span className="status-badge status-active">{shippingRow.status || "No status"}</span>
              </div>
              {shippingRow.sheetName || shippingRow.tabName ? (
                <p className="muted source-line">
                  {[shippingRow.sheetName, shippingRow.tabName].filter(Boolean).join(" / ")}
                </p>
              ) : null}
              <p className="personalization">{shippingRow.personalization || shippingRow.trackingId}</p>
              <p className="muted">Tracking: {shippingRow.trackingId}</p>
              <div className="field-row">
                <label htmlFor="shipping-status">Internal Status</label>
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
          <div className="multi-sheet-list" aria-label="Search sheets">
            <label>Use these sheets in search</label>
            {sheetProfiles.map((profile) => (
              <div className="sheet-choice" key={profile.id}>
                <label className="sheet-choice-check">
                  <input
                    type="checkbox"
                    checked={activeProfileIds.includes(profile.id)}
                    onChange={(event) => handleProfileEnabled(profile.id, event.target.checked)}
                  />
                  <span>{profile.name}</span>
                </label>
                <select value={profile.tabName} onChange={(event) => handleProfileTabChange(profile.id, event.target.value)}>
                  <option value={profile.tabName}>{profile.tabName || "Select tab"}</option>
                  {(profile.tabs ?? []).filter((tab) => tab.title !== profile.tabName).map((tab) => (
                    <option value={tab.title} key={tab.sheetId}>
                      {tab.title}
                    </option>
                  ))}
                </select>
                <button
                  className="delete-sheet-button"
                  type="button"
                  onClick={() => handleDeleteSheetProfile(profile.id)}
                  disabled={sheetProfiles.length <= 1}
                >
                  Delete Sheet
                </button>
              </div>
            ))}
          </div>
          <div className="field-row">
            <label htmlFor="settings-sheet-profile">Edit sheet</label>
            <div className="icon-field">
              <img src="/icons/spreadsheet.svg" alt="" aria-hidden="true" />
              <select id="settings-sheet-profile" value={activeProfileId} onChange={(event) => handleProfileChange(event.target.value)}>
                {sheetProfiles.map((profile) => (
                  <option value={profile.id} key={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <label htmlFor="settings-tab">Month / tab</label>
            <div className="inline-controls">
              <div className="icon-field">
                <img src="/icons/spreadsheet.svg" alt="" aria-hidden="true" />
                <select
                  id="settings-tab"
                  value={activeProfile?.tabName ?? ""}
                  onChange={(event) => handleTabChange(event.target.value)}
                >
                  <option value={activeProfile?.tabName ?? ""}>{activeProfile?.tabName || "Select tab"}</option>
                  {activeProfileTabs.filter((tab) => tab.title !== activeProfile?.tabName).map((tab) => (
                    <option value={tab.title} key={tab.sheetId}>
                      {tab.title}
                    </option>
                  ))}
                </select>
              </div>
              <button className="secondary-button compact" type="button" onClick={handleLoadTabs} disabled={isLoadingTabs}>
                {isLoadingTabs ? "Loading..." : "Fetch"}
              </button>
            </div>
          </div>
          <form className="add-sheet-form" onSubmit={handleAddSheetProfile}>
            <label>Add new sheet</label>
            <input value={newSheetUrl} onChange={(event) => setNewSheetUrl(event.target.value)} placeholder="Paste Google Sheet URL" />
            <button className="secondary-button" type="button" onClick={handleFetchNewSheetInfo} disabled={isFetchingNewSheet || !newSheetUrl.trim()}>
              {isFetchingNewSheet ? "Fetching Sheet..." : "Fetch Sheet Name & Tabs"}
            </button>
            <input value={newSheetName} onChange={(event) => setNewSheetName(event.target.value)} placeholder="Sheet name" />
            <select value={newSheetTab} onChange={(event) => setNewSheetTab(event.target.value)}>
              <option value="">{newSheetTabs.length ? "Choose month/tab" : "Fetch tabs first"}</option>
              {newSheetTabs.map((tab) => (
                <option value={tab.title} key={tab.sheetId}>
                  {tab.title}
                </option>
              ))}
            </select>
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
          <img src="/icons/camera.svg" alt="" aria-hidden="true" />
          <small>Photos</small>
        </button>
        <button className={activeView === "shipping" ? "is-active" : ""} type="button" onClick={() => setActiveView("shipping")}>
          <img src="/icons/shipping-box.svg" alt="" aria-hidden="true" />
          <small>Shipping</small>
        </button>
        <button className={activeView === "settings" ? "is-active" : ""} type="button" onClick={() => setActiveView("settings")}>
          <img src="/icons/settings.svg" alt="" aria-hidden="true" />
          <small>Settings</small>
        </button>
      </nav>
    </main>
  );
}

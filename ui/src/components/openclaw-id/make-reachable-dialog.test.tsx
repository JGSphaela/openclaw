/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { showMakeReachableDialog } from "./make-reachable-dialog.tsx";

// Replace browser key custody, not the dialog's linking sequence or publication messages.
// mock-isolation: key generation and the root ceremony are replaced so the dialog's step flow runs deterministically.
vi.mock("../../lib/openclaw-id/device-key.ts", () => ({
  generateOwnerDeviceKey: async () => ({ signer: {}, pair: {} }),
  saveOwnerDeviceKey: async () => {},
}));
// mock-isolation: key generation and the root ceremony are replaced so the dialog's step flow runs deterministically.
vi.mock("../../lib/openclaw-id/link.ts", () => ({
  linkCodePageUrl: () => "https://claws.test/link",
  createOpenClawIdCeremony: () => ({
    createKit: async () => ({ text: "synthetic kit", rootFingerprint: "synthetic fingerprint" }),
    sign: async () => ({}),
    discard: () => {},
  }),
}));

// Click only enabled controls, so assertions follow the actual wizard gates.
async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    button!.click();
  });
}

describe("Make reachable publication outcome", () => {
  afterEach(() => {
    cleanupSolid();
    localStorage.removeItem("openclaw.openclawId.account");
    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  });

  it.each(["account_link_code", "check_name", "prepare"])(
    "stops at a preview refusal from %s without linking",
    async (deniedAction) => {
      const signedIn = {
        sub: "outsider",
        email: "outsider@example.test",
        name: null,
        exp: 4_102_444_800,
        idToken: "synthetic",
      };
      const storage = installSafeLocalStorageForTesting();
      storage.setItem("openclaw.openclawId.account", JSON.stringify(signedIn));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.openclawId.account",
          newValue: JSON.stringify(signedIn),
        }),
      );
      const request = vi.fn(async (_method: string, params: { action: string }) => {
        if (params.action === deniedAction) {
          throw Object.assign(new Error("Private preview"), {
            details: { code: "preview_access_required" },
          });
        }
        return params.action === "account_link_code"
          ? { code: "synthetic-code" }
          : { hostname: "studio-test.claws.test", available: true };
      });
      const done = showMakeReachableDialog({
        client: { request } as unknown as GatewayBrowserClient,
        loaderDomain: "claws.test",
        signedIn,
      });
      if (deniedAction === "prepare") {
        await click("Continue");
      }
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("outsider@example.test isn't enabled yet"),
      );
      expect(document.body.textContent).toContain("Sign out / use another account");
      expect(request.mock.calls.some(([, params]) => params.action === "commit")).toBe(false);
      expect(document.querySelector("input")).toBeNull();
      await click("Close");
      await done;
    },
  );

  it.each([
    { code: "unavailable", retryable: true, expected: "will keep trying", online: true },
    { code: "internal", retryable: true, expected: "will keep trying", online: true },
    {
      code: "preview_access_required",
      retryable: false,
      expected: "This claw is linked locally, but remote access is not enabled",
      online: true,
    },
    {
      code: "registration_mismatch",
      retryable: false,
      expected: "does not match the saved ownership details",
      online: false,
    },
    {
      code: "unavailable",
      retryable: false,
      expected: "Remote access setup could not finish",
      online: true,
    },
  ])(
    "maps publication $code (retryable $retryable) without claiming readiness",
    async ({ code, retryable, expected, online }) => {
      const request = vi.fn(async (method: string, params: { action?: string }) => {
        if (method === "openclawId.status") {
          return { status: { state: "on", tunnel: { state: "running", relayOnline: online } } };
        }
        if (params.action === "account_link_code") {
          return { code: "synthetic-code" };
        }
        if (params.action === "commit") {
          return {
            publication: {
              state: "failed",
              code,
              message: "HTTP 503",
              retryable,
            },
          };
        }
        return { claw_id: "synthetic-claw", hostname: "studio-test.claws.test", available: true };
      });
      const signedIn = {
        sub: "owner",
        email: "owner@example.test",
        name: null,
        exp: 2_000_000_000,
        idToken: "synthetic",
      };
      const storage = installSafeLocalStorageForTesting();
      storage.setItem("openclaw.openclawId.account", JSON.stringify(signedIn));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.openclawId.account",
          newValue: JSON.stringify(signedIn),
        }),
      );
      const done = showMakeReachableDialog({
        client: { request } as unknown as GatewayBrowserClient,
        loaderDomain: "claws.test",
        signedIn,
      });
      await click("Continue");
      await click("Create recovery kit");
      await vi.waitFor(() =>
        expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
      );
      const password = document.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )!;
      expect(password.value).toBe("synthetic kit");
      expect(request.mock.calls.some(([, params]) => params.action === "commit")).toBe(false);
      const form = password.form!;
      const submitted = vi.fn();
      form.addEventListener("submit", submitted);
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      await click("Continue");
      await vi.waitFor(() => expect(document.body.textContent).toContain("HTTP 503"));
      expect(submitted).toHaveBeenCalledOnce();
      form.removeEventListener("submit", submitted);
      expect(password.value).toBe("");
      expect(document.body.textContent).toContain(expected);
      if (code === "preview_access_required") {
        expect(document.body.textContent).not.toContain("Sign out / use another account");
        expect(document.body.textContent).not.toContain("Your claw address is");
        expect(document.body.textContent).toContain('"action":"publish"');
        expect(document.body.textContent).toContain("Do not repeat setup");
        expect(request.mock.calls.filter(([, params]) => params.action === "commit")).toHaveLength(
          1,
        );
      }
      if (online && !retryable) {
        expect(document.body.textContent).not.toContain("will keep trying");
      }
      if (!online) {
        expect(document.body.textContent).toContain("Remote access is not connected yet");
      }
      const details = [...document.querySelectorAll("details")].find((item) =>
        item.textContent?.includes("HTTP 503"),
      );
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
      expect(document.body.textContent).not.toMatch(/add an enrollment code/i);
      await click("Done");
      expect(await done).toBe(true);
    },
  );
});

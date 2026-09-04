import { describe, expect, test } from "bun:test";
import { freshRadioProvisioningPayload } from "./radio-onboarding";

describe("radio onboarding", () => {
  test("creates a fresh radio without a channel even when an old client sends one", () => {
    const payload = freshRadioProvisioningPayload({
      body: {
        channel_ids: [1],
        default_channel_id: 1,
        service_ends_at: "2028-09-04 00:00:00",
        gps_enabled: true,
        gps_frequency: 30,
      },
      companyId: 55,
      imei: "867951075209193",
      name: "Test radio",
    });

    expect(payload.channelIds).toEqual([]);
    expect(payload.defaultChannelId).toBeNull();
    expect(payload.companyId).toBe(55);
  });
});

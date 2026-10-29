type FreshRadioInput = {
  service_ends_at?: string;
  gps_enabled?: boolean;
  gps_frequency?: number | string;
  // Older clients may still send these fields. Fresh radios intentionally
  // ignore them; channel membership is managed after onboarding.
  channel_ids?: unknown;
  default_channel_id?: unknown;
};

export function freshRadioProvisioningPayload({
  body,
  companyId,
  imei,
  name,
}: {
  body: FreshRadioInput;
  companyId: number | null;
  imei: string;
  name: string;
}) {
  return {
    companyId,
    imei,
    name,
    channelIds: [] as number[],
    defaultChannelId: null,
    serviceEndsAt: body.service_ends_at || "2030-01-01 00:00:00",
    gpsEnabled: body.gps_enabled !== false,
    // 5s is what makes a moving radio track smoothly on the map; every radio on
    // the network was moved to it on 29 Oct 2026, and the battery cost is small.
    gpsFrequency: Number(body.gps_frequency || 5),
  };
}

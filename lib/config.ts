export interface EmailCampaignConfig {
  /** Sending domain */
  domain: string;
  /** Display name used in the From line */
  fromDisplayName: string;
  /** Local part of the From address */
  fromLocalPart: string;
  /** Reply-To address */
  replyToAddress: string;
  /** Postal address for CAN-SPAM footer */
  postalAddress: string;
  /** Organization name for footer */
  organizationName: string;
  /** SES configuration set name */
  configurationSetName: string;
  /** Tenant / namespace tag (SES tenant if available, otherwise used as tag) */
  tenantName: string;
  /** Subdomain used for custom MAIL FROM */
  mailFromSubdomain: string;
  /** Subdomain for HTTPS unsubscribe service */
  unsubSubdomain: string;
  /** Subdomain for open/click tracking */
  trackingSubdomain: string;
  /** Subdomain for inbound mailto + DMARC reports */
  optoutSubdomain: string;
  /** Default business-hours send window */
  sendWindow: {
    timezone: string;
    startLocal: string; // HH:MM
    endLocal: string;   // HH:MM
    days: number[];     // 0 = Sunday
  };
  /** Estimated daily SmartReach volume on this domain, for warm-up counting */
  dailySmartReachVolume: number;
  /** Validation verdicts that are queueable */
  queueableValidationVerdicts: ('HIGH' | 'MEDIUM')[];
}

export const lexaraConfig: EmailCampaignConfig = {
  domain: 'lexara.vip',
  fromDisplayName: 'Amy, Lexara',
  fromLocalPart: 'amy',
  replyToAddress: 'amy@lexara.com',
  postalAddress: '500 W. Hickman #318, Waukee, IA 50263',
  organizationName: 'Lexara',
  configurationSetName: 'lexara-bulk',
  tenantName: 'lexara',
  mailFromSubdomain: 'bounce',
  unsubSubdomain: 'unsub',
  trackingSubdomain: 't',
  optoutSubdomain: 'optout',
  sendWindow: {
    timezone: 'America/Detroit',
    startLocal: '08:00',
    endLocal: '17:00',
    days: [1, 2, 3, 4, 5], // Mon-Fri
  },
  dailySmartReachVolume: 0, // configurable; set via config or override
  queueableValidationVerdicts: ['HIGH', 'MEDIUM'],
};

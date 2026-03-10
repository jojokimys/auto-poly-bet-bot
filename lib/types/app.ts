/** App-level market types (normalized from Gamma API) */

export interface Outcome {
  name: string;
  price: number;
  tokenId: string;
}

export interface Market {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  liquidity: number;
  volume: number;
  active: boolean;
  closed: boolean;
  outcomes: Outcome[];
  description?: string;
  image?: string;
  icon?: string;
  negRisk?: boolean;
}

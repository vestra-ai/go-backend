// What the flight e-ticket shows (mock-tickets/flights, as it is): every value is display text, already formatted.
export interface FlightEndpoint {
  code: string; // "DEL"
  time: string; // "07:50"
  date: string; // "Fri, 11 Sep '26"
  city: string; // "New Delhi"
  airport: string; // "Indira Gandhi International Airport"
  terminal?: string; // "Terminal 1"
}

export interface Traveller {
  name: string; // "Mr. Naga Keshav Musunuri"
  pnr: string;
  eTicketNo?: string; // "-" when empty
  sector?: string; // "DEL-RJA"
  seat?: string;
  meal?: string;
}

export interface TicketData {
  bookingId: string;
  brand: {
    name: string; // text shown in the top-right badge
    color?: string; // badge background
    logoDataUri?: string; // optional image instead of the text badge
  };
  assured?: {
    title: string;
    subtitle: string;
  };
  journey: {
    month: string; // "SEP"
    day: string; // "11"
    weekday: string; // "Fri"
    from: string; // "NEW DELHI"
    to: string; // "RAJAHMUNDRY"
    status: string; // "CONFIRMED"
    stops: string; // "Nonstop"
    duration: string; // "2h 30m"
  };
  flight: {
    airline: string; // "IndiGo"
    flightNo: string; // "6E-6446"
    cabin: string; // "Economy"
    fareType?: string; // "SAVER"
    airlineLogoDataUri?: string;
  };
  departure: FlightEndpoint;
  arrival: FlightEndpoint;
  baggage: {
    checkIn: string; // "15 kg per piece, 1 piece per adult"
    cabin: string; // "7 kg per adult"
  };
  travellers: Traveller[];
}

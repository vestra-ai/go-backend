// What the hotel voucher shows (mock-tickets/stays, as it is): every value is display text, already formatted.
export interface CancellationRule {
  title: string; // "Fully refundable before 06 Aug 2024 11:59 PM"
  description: string; // "Cancel your reservation before ..., to get a full refund"
}

export interface HotelBookingData {
  bookingId: string; // "IH8382754166504596"
  hotelBookingNumber?: string;
  bookedOn: string; // "29 May 2024"
  brand: {
    name: string; // text shown in the top-left badge and in "<name> Booking ID"
    color?: string;
    logoDataUri?: string;
  };
  hotel: {
    name: string;
    address: string;
    mapUrl?: string; // "View on Map" is shown only when set
  };
  status?: string; // defaults to "Booking Confirmed"
  checkIn: string; // "Thu, 08 Aug"
  checkOut: string; // "Wed, 14 Aug"
  primaryGuest: {
    name: string;
    email?: string;
  };
  travellers: string; // "2 Adults"
  guestId?: { label: string; value: string }; // e.g. { label: "PAN", value: "..." }
  rooms: {
    summary: string; // "1 x King Room"
    inclusions?: string; // "Express check-in, Free WiFi"
  };
  price: {
    currency?: string; // defaults to "₹"
    total: string; // "132368.56"
    note?: string; // defaults to "(including taxes & charges)"
    paymentMode?: string; // "Booked with 0 payment"
    payByDeadline?: string; // "05 Aug, 11:59 PM IST" → "Pay the full amount of ... before ..."
    additionalCharges?: { label: string; amount: string }[]; // paid at the hotel
  };
  cancellation: {
    rules: CancellationRule[];
    footnote?: string; // "All date and time are in hotel's timezone"
  };
  support?: {
    title: string; // "ixigo Support"
    phone?: string;
    email?: string;
  };
  terms?: {
    title: string; // "ixigo Terms & Conditions"
    items: string[];
  };
  company?: {
    name: string;
    address: string;
    serviceDescription?: string;
    cin?: string;
    pan?: string;
    hsnSac?: string;
  };
}

import type { Radius, VehicleTypeId } from "@/features/pricing/types";

/**
 * Словари вымышленных данных витрины. Люди, машины и шины придуманы; любое
 * совпадение с настоящими клиентами случайно. Телефоны — из диапазона
 * +7 9XX федеральных операторов, госномера — формат РФ с регионами со всей
 * страны: по данным витрины нельзя угадать город точек. ИНН юрлиц — с
 * несуществующим кодом региона 00, настоящими быть не могут.
 */

export const MALE_FIRST_NAMES = [
  "Александр", "Алексей", "Андрей", "Антон", "Артём", "Борис", "Вадим", "Валерий", "Василий",
  "Виктор", "Виталий", "Владимир", "Владислав", "Вячеслав", "Геннадий", "Георгий", "Глеб",
  "Григорий", "Даниил", "Денис", "Дмитрий", "Евгений", "Егор", "Иван", "Игорь", "Илья",
  "Кирилл", "Константин", "Леонид", "Максим", "Марк", "Матвей", "Михаил", "Никита",
  "Николай", "Олег", "Павел", "Пётр", "Роман", "Руслан", "Сергей", "Станислав", "Степан",
  "Тимофей", "Тимур", "Фёдор", "Юрий", "Ярослав", "Эдуард", "Арсений",
];

export const FEMALE_FIRST_NAMES = [
  "Анастасия", "Анна", "Валентина", "Вера", "Виктория", "Галина", "Дарья", "Евгения",
  "Екатерина", "Елена", "Елизавета", "Ирина", "Кристина", "Ксения", "Лариса", "Людмила",
  "Марина", "Мария", "Надежда", "Наталья", "Оксана", "Ольга", "Полина", "Светлана",
  "София", "Татьяна", "Юлия", "Яна",
];

/** Фамилия в мужской форме и её женская пара. */
export const LAST_NAMES: Array<[string, string]> = [
  ["Смирнов", "Смирнова"], ["Кузнецов", "Кузнецова"], ["Попов", "Попова"], ["Васильев", "Васильева"],
  ["Петров", "Петрова"], ["Соколов", "Соколова"], ["Михайлов", "Михайлова"], ["Новиков", "Новикова"],
  ["Фёдоров", "Фёдорова"], ["Морозов", "Морозова"], ["Волков", "Волкова"], ["Алексеев", "Алексеева"],
  ["Лебедев", "Лебедева"], ["Семёнов", "Семёнова"], ["Егоров", "Егорова"], ["Павлов", "Павлова"],
  ["Козлов", "Козлова"], ["Степанов", "Степанова"], ["Николаев", "Николаева"], ["Орлов", "Орлова"],
  ["Андреев", "Андреева"], ["Макаров", "Макарова"], ["Никитин", "Никитина"], ["Захаров", "Захарова"],
  ["Зайцев", "Зайцева"], ["Соловьёв", "Соловьёва"], ["Борисов", "Борисова"], ["Яковлев", "Яковлева"],
  ["Григорьев", "Григорьева"], ["Романов", "Романова"], ["Воробьёв", "Воробьёва"], ["Сергеев", "Сергеева"],
  ["Кузьмин", "Кузьмина"], ["Фролов", "Фролова"], ["Александров", "Александрова"], ["Дмитриев", "Дмитриева"],
  ["Королёв", "Королёва"], ["Гусев", "Гусева"], ["Киселёв", "Киселёва"], ["Ильин", "Ильина"],
  ["Максимов", "Максимова"], ["Поляков", "Полякова"], ["Сорокин", "Сорокина"], ["Виноградов", "Виноградова"],
  ["Ковалёв", "Ковалёва"], ["Белов", "Белова"], ["Медведев", "Медведева"], ["Антонов", "Антонова"],
  ["Тарасов", "Тарасова"], ["Жуков", "Жукова"], ["Баранов", "Баранова"], ["Филиппов", "Филиппова"],
  ["Комаров", "Комарова"], ["Давыдов", "Давыдова"], ["Беляев", "Беляева"], ["Герасимов", "Герасимова"],
  ["Богданов", "Богданова"], ["Осипов", "Осипова"], ["Сидоров", "Сидорова"], ["Матвеев", "Матвеева"],
  ["Титов", "Титова"], ["Марков", "Маркова"], ["Миронов", "Миронова"], ["Крылов", "Крылова"],
  ["Куликов", "Куликова"], ["Карпов", "Карпова"], ["Власов", "Власова"], ["Мельников", "Мельникова"],
  ["Денисов", "Денисова"], ["Гаврилов", "Гаврилова"], ["Тихонов", "Тихонова"], ["Казаков", "Казакова"],
  ["Афанасьев", "Афанасьева"], ["Данилов", "Данилова"], ["Савельев", "Савельева"], ["Тимофеев", "Тимофеева"],
  ["Фомин", "Фомина"], ["Чернов", "Чернова"], ["Абрамов", "Абрамова"], ["Мартынов", "Мартынова"],
  ["Ефимов", "Ефимова"], ["Щербаков", "Щербакова"], ["Назаров", "Назарова"], ["Калинин", "Калинина"],
  ["Исаев", "Исаева"], ["Чернышёв", "Чернышёва"], ["Быков", "Быкова"], ["Маслов", "Маслова"],
  ["Родионов", "Родионова"], ["Коновалов", "Коновалова"], ["Лазарев", "Лазарева"], ["Воронин", "Воронина"],
  ["Климов", "Климова"], ["Филатов", "Филатова"], ["Пономарёв", "Пономарёва"], ["Голубев", "Голубева"],
  ["Кудрявцев", "Кудрявцева"], ["Прохоров", "Прохорова"], ["Наумов", "Наумова"], ["Потапов", "Потапова"],
  ["Журавлёв", "Журавлёва"], ["Овчинников", "Овчинникова"], ["Трофимов", "Трофимова"], ["Леонов", "Леонова"],
  ["Соболев", "Соболева"], ["Ермаков", "Ермакова"], ["Колесников", "Колесникова"], ["Гончаров", "Гончарова"],
  ["Емельянов", "Емельянова"], ["Никифоров", "Никифорова"], ["Грачёв", "Грачёва"], ["Котов", "Котова"],
];

export const MALE_PATRONYMICS = [
  "Александрович", "Алексеевич", "Андреевич", "Викторович", "Владимирович", "Дмитриевич",
  "Евгеньевич", "Иванович", "Игоревич", "Михайлович", "Николаевич", "Олегович", "Павлович",
  "Петрович", "Сергеевич", "Юрьевич", "Анатольевич", "Валерьевич",
];

export const FEMALE_PATRONYMICS = [
  "Александровна", "Алексеевна", "Андреевна", "Викторовна", "Владимировна", "Дмитриевна",
  "Евгеньевна", "Ивановна", "Игоревна", "Михайловна", "Николаевна", "Олеговна", "Павловна",
  "Петровна", "Сергеевна", "Юрьевна",
];

export type DemoCarModel = {
  brand: string;
  model: string;
  vehicleType: VehicleTypeId;
  radii: Radius[];
  /** Доля в потоке машин: чем больше, тем чаще встречается. */
  weight: number;
  lowProfileChance?: number;
  runflatChance?: number;
};

export const CAR_MODELS: DemoCarModel[] = [
  { brand: "Lada", model: "Vesta", vehicleType: "passenger", radii: ["R15", "R16"], weight: 14 },
  { brand: "Lada", model: "Granta", vehicleType: "passenger", radii: ["R14", "R15"], weight: 12 },
  { brand: "Kia", model: "Rio", vehicleType: "passenger", radii: ["R15", "R16"], weight: 10 },
  { brand: "Hyundai", model: "Solaris", vehicleType: "passenger", radii: ["R15", "R16"], weight: 10 },
  { brand: "Volkswagen", model: "Polo", vehicleType: "passenger", radii: ["R15"], weight: 6 },
  { brand: "Skoda", model: "Rapid", vehicleType: "passenger", radii: ["R15", "R16"], weight: 5 },
  { brand: "Skoda", model: "Octavia", vehicleType: "passenger", radii: ["R16", "R17"], weight: 5 },
  { brand: "Toyota", model: "Corolla", vehicleType: "passenger", radii: ["R16"], weight: 4 },
  { brand: "Toyota", model: "Camry", vehicleType: "passenger", radii: ["R17", "R18"], weight: 5, lowProfileChance: 0.2 },
  { brand: "Kia", model: "K5", vehicleType: "passenger", radii: ["R17", "R18"], weight: 3, lowProfileChance: 0.2 },
  { brand: "Renault", model: "Logan", vehicleType: "passenger", radii: ["R15"], weight: 4 },
  { brand: "Nissan", model: "Almera", vehicleType: "passenger", radii: ["R15"], weight: 2 },
  { brand: "Mazda", model: "3", vehicleType: "passenger", radii: ["R16", "R18"], weight: 2 },
  { brand: "BMW", model: "3 серии", vehicleType: "passenger", radii: ["R17", "R18"], weight: 2, lowProfileChance: 0.5, runflatChance: 0.35 },
  { brand: "Mercedes-Benz", model: "E-класс", vehicleType: "passenger", radii: ["R18"], weight: 1, lowProfileChance: 0.5, runflatChance: 0.3 },
  { brand: "Hyundai", model: "Creta", vehicleType: "suv", radii: ["R16", "R17"], weight: 8 },
  { brand: "Kia", model: "Sportage", vehicleType: "suv", radii: ["R17", "R18"], weight: 5 },
  { brand: "Haval", model: "Jolion", vehicleType: "suv", radii: ["R17", "R18"], weight: 6 },
  { brand: "Chery", model: "Tiggo 7 Pro", vehicleType: "suv", radii: ["R18"], weight: 5 },
  { brand: "Geely", model: "Coolray", vehicleType: "suv", radii: ["R17", "R18"], weight: 4 },
  { brand: "Geely", model: "Monjaro", vehicleType: "suv", radii: ["R19", "R20"], weight: 3, lowProfileChance: 0.3 },
  { brand: "Nissan", model: "Qashqai", vehicleType: "suv", radii: ["R17"], weight: 3 },
  { brand: "Renault", model: "Duster", vehicleType: "suv", radii: ["R16", "R17"], weight: 4 },
  { brand: "Toyota", model: "RAV4", vehicleType: "suv", radii: ["R17", "R18"], weight: 4 },
  { brand: "Volkswagen", model: "Tiguan", vehicleType: "suv", radii: ["R17", "R18"], weight: 3 },
  { brand: "Mazda", model: "CX-5", vehicleType: "suv", radii: ["R17", "R19"], weight: 2 },
  { brand: "Skoda", model: "Kodiaq", vehicleType: "suv", radii: ["R18"], weight: 2 },
  { brand: "Toyota", model: "Land Cruiser Prado", vehicleType: "offroad", radii: ["R17", "R18"], weight: 3 },
  { brand: "Mitsubishi", model: "Pajero Sport", vehicleType: "offroad", radii: ["R17", "R18"], weight: 2 },
  { brand: "УАЗ", model: "Патриот", vehicleType: "offroad", radii: ["R16", "R18"], weight: 2 },
  { brand: "Lada", model: "Niva Travel", vehicleType: "offroad", radii: ["R15", "R16"], weight: 3 },
  { brand: "BMW", model: "X5", vehicleType: "offroad", radii: ["R19", "R20"], weight: 2, lowProfileChance: 0.4, runflatChance: 0.5 },
  { brand: "Tank", model: "300", vehicleType: "offroad", radii: ["R17", "R18"], weight: 2 },
  { brand: "Haval", model: "H9", vehicleType: "offroad", radii: ["R18"], weight: 1 },
  { brand: "ГАЗ", model: "Газель Next", vehicleType: "commercial", radii: ["R16"], weight: 3 },
  { brand: "Ford", model: "Transit", vehicleType: "commercial", radii: ["R16"], weight: 1 },
  { brand: "Mercedes-Benz", model: "Sprinter", vehicleType: "commercial", radii: ["R16"], weight: 1 },
];

export const TIRE_BRANDS_WINTER = [
  "Nokian Hakkapeliitta 10", "Ikon Nordman 8", "Cordiant Snow Cross 2", "Pirelli Ice Zero 2",
  "Michelin X-Ice North 4", "Continental IceContact 3", "Yokohama iceGuard IG65", "Kumho WinterCraft WI32",
  "Gislaved Nord Frost 200", "Bridgestone Blizzak Spike-03",
];

export const TIRE_BRANDS_SUMMER = [
  "Ikon Nordman SX3", "Cordiant Comfort 2", "Michelin Primacy 4+", "Continental PremiumContact 7",
  "Pirelli Cinturato P7", "Yokohama BluEarth-GT", "Hankook Ventus Prime 4", "Kumho Ecsta HS52",
  "Bridgestone Turanza 6", "Toyo Proxes Comfort",
];

/** Типоразмер под диаметр — для подписи комплекта на хранении. */
export const TIRE_SIZE_BY_RADIUS: Partial<Record<Radius, string[]>> = {
  R14: ["175/65", "185/60"],
  R15: ["185/65", "195/65", "185/60"],
  R16: ["205/55", "215/60", "205/60"],
  R17: ["225/45", "215/60", "225/65"],
  R18: ["225/60", "235/55", "245/45"],
  R19: ["235/55", "255/50"],
  R20: ["265/50", "275/45"],
  R21: ["275/40"],
  R22: ["285/40"],
};

export const PLATE_LETTERS = "АВЕКМНОРСТУХ";
// Регионы со всей страны, без регионов пояса точек (UTC+5).
export const PLATE_REGIONS = [
  "77", "177", "197", "777", "50", "150", "750", "78", "178", "98", "47", "23", "123", "61", "161", "16", "116",
  "52", "152", "63", "163", "54", "154", "36", "34", "24", "38", "26", "64", "40", "71", "76", "33",
];

// ИНН заведомо вымышленные: код региона 00 не существует.
export const LEGAL_CLIENTS = [
  { name: "ООО «Снабтранс»", inn: "0000000001" },
  { name: "ООО «Северный маршрут»", inn: "0000000002" },
  { name: "ООО «Горная логистика»", inn: "0000000003" },
  { name: "ООО «Такси Восток»", inn: "0000000004" },
  { name: "ООО «СтройМонтажСервис»", inn: "0000000005" },
  { name: "ИП Белов Роман Олегович", inn: "000000000006" },
];

export const SHIFT_EXPENSES = [
  { description: "Грузы для балансировки", min: 450, max: 1200 },
  { description: "Вода и чай для клиентов", min: 250, max: 600 },
  { description: "Вентили и золотники", min: 300, max: 900 },
  { description: "Моющее средство для дисков", min: 350, max: 800 },
  { description: "Перчатки и ветошь", min: 200, max: 500 },
  { description: "Доставка шин от поставщика", min: 500, max: 1500 },
];

export const BOOKING_COMMENTS = [
  "Переобуть на зимнюю резину",
  "Сезонная замена, свои шины",
  "Шины на хранении у вас",
  "Прокол, правое заднее",
  "Балансировка, бьёт руль на 100 км/ч",
  "Замена резины, диски литые",
  "Переобувка + мойка колёс",
  "",
  "",
];

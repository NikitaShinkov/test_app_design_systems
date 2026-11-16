export interface Contact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  position?: string;
  /** ISO date-time; the list is sorted by this field, newest first. */
  createdAt: string;
}

/** The 10 newest records, as shown in the reference screenshot. */
const screenshotContacts: Omit<Contact, 'id' | 'createdAt'>[] = [
  {
    name: 'RESPONSIVE AUDIT Contact With A Longer Display Name',
    email: 'long.contact.address.for.responsive.testing@preservation.example',
  },
  { name: 'ZZ Preserved contact-only', email: 'changed-contact-only@preservation.example' },
  { name: 'ZZ Established preserved contact', email: 'changed-existing@preservation.example' },
  { name: 'ZZ Preserved new', email: 'changed-new@preservation.example' },
  { name: 'Journey Engineer 6', email: 'engineer6@journey.example' },
  { name: 'ZZ Journey 5 established contact', email: 'established5@journey.example' },
  { name: 'Journey Engineer 4', email: 'engineer4@journey.example' },
  { name: 'Journey Engineer 3', email: 'engineer3@journey.example' },
  { name: 'Journey Engineer 2', email: 'engineer2@journey.example' },
  { name: 'Journey Engineer 1', email: 'engineer1@journey.example' },
];

/** Older records (pages 2–4), some with phone and position filled in. */
const olderContacts: Omit<Contact, 'id' | 'createdAt'>[] = [
  { name: 'Анна Смирнова', email: 'a.smirnova@example.ru', phone: '+7 495 123-45-67', position: 'Менеджер по продажам' },
  { name: 'Иван Петров', email: 'i.petrov@example.ru', phone: '+7 812 555-01-02', position: 'Технический директор' },
  { name: 'Мария Кузнецова', email: 'm.kuznetsova@example.ru', position: 'Бухгалтер' },
  { name: 'Дмитрий Соколов', email: 'd.sokolov@example.ru', phone: '+7 903 777-88-99' },
  { name: 'Елена Попова', email: 'e.popova@example.ru', phone: '+7 916 222-33-44', position: 'HR-специалист' },
  { name: 'Алексей Волков', email: 'a.volkov@example.ru', position: 'Инженер' },
  { name: 'Ольга Новикова', email: 'o.novikova@example.ru', phone: '+7 926 410-20-30', position: 'Юрист' },
  { name: 'Сергей Морозов', email: 's.morozov@example.ru' },
  { name: 'Наталья Лебедева', email: 'n.lebedeva@example.ru', phone: '+7 985 600-70-80', position: 'Руководитель отдела' },
  { name: 'Павел Козлов', email: 'p.kozlov@example.ru', position: 'Аналитик' },
  { name: 'John Carter', email: 'john.carter@acme.example', phone: '+1 415 555-0134', position: 'Procurement Lead' },
  { name: 'Laura Schmidt', email: 'laura.schmidt@contoso.example', phone: '+49 30 1234 5678', position: 'Operations Manager' },
  { name: 'Marco Rossi', email: 'marco.rossi@fabrikam.example', position: 'Account Executive' },
  { name: 'Sophie Martin', email: 'sophie.martin@northwind.example', phone: '+33 1 23 45 67 89' },
  { name: 'Татьяна Орлова', email: 't.orlova@example.ru', phone: '+7 499 300-40-50', position: 'Офис-менеджер' },
  { name: 'Никита Фёдоров', email: 'n.fedorov@example.ru', position: 'Разработчик' },
  { name: 'Юлия Васильева', email: 'y.vasilyeva@example.ru', phone: '+7 921 111-22-33', position: 'Маркетолог' },
  { name: 'Андрей Михайлов', email: 'a.mikhaylov@example.ru' },
  { name: 'Ксения Егорова', email: 'k.egorova@example.ru', phone: '+7 960 505-15-25', position: 'Специалист поддержки' },
  { name: 'Роман Николаев', email: 'r.nikolaev@example.ru', position: 'Директор по развитию' },
  { name: 'Test Contact 7', email: 'contact7@test.example' },
  { name: 'Test Contact 6', email: 'contact6@test.example' },
  { name: 'Test Contact 5', email: 'contact5@test.example' },
  { name: 'Test Contact 4', email: 'contact4@test.example' },
  { name: 'Test Contact 3', email: 'contact3@test.example' },
  { name: 'Test Contact 2', email: 'contact2@test.example' },
  { name: 'Test Contact 1', email: 'contact1@test.example' },
];

const newest = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** 37 contacts, newest first. */
export const contacts: Contact[] = [...screenshotContacts, ...olderContacts].map((c, i) => ({
  ...c,
  id: `c-${String(37 - i).padStart(3, '0')}`,
  createdAt: new Date(newest - i * 7 * HOUR).toISOString(),
}));

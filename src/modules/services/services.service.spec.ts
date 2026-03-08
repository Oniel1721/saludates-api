import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServicesService } from '@/modules/services/services.service';

describe('ServicesService', () => {
  let service: ServicesService;
  let prisma: Record<string, jest.Mock>;

  const makeService = (overrides = {}) => ({
    id: 's1',
    clinicId: 'c1',
    name: 'Consulta',
    price: 1500,
    durationMinutes: 30,
    prerequisites: null,
    archivedAt: null,
    parentServiceId: null,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      service: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        $transaction: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    service = new ServicesService(prisma as never);
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('throws NotFoundException when service does not exist', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.update('c1', 's1', { name: 'New' })).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when service is already archived', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService({ archivedAt: new Date() }));
      await expect(service.update('c1', 's1', { name: 'New' })).rejects.toThrow(BadRequestException);
    });

    it('updates in-place when price does NOT change', async () => {
      const svc = makeService();
      prisma.service.findFirst.mockResolvedValue(svc);
      prisma.service.update.mockResolvedValue({ ...svc, name: 'New Name' });

      await service.update('c1', 's1', { name: 'New Name' });

      expect(prisma.service.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { name: 'New Name', durationMinutes: undefined, prerequisites: undefined },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('updates in-place when price field is omitted entirely', async () => {
      const svc = makeService();
      prisma.service.findFirst.mockResolvedValue(svc);
      prisma.service.update.mockResolvedValue(svc);

      await service.update('c1', 's1', { durationMinutes: 45 });

      expect(prisma.service.update).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('archives old and creates new version when price changes', async () => {
      const svc = makeService({ price: 1500 });
      prisma.service.findFirst.mockResolvedValue(svc);

      // Simulate $transaction calling the callback
      const newSvc = makeService({ id: 's2', price: 2000, parentServiceId: 's1' });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          service: {
            update: jest.fn().mockResolvedValue({ ...svc, archivedAt: new Date() }),
            create: jest.fn().mockResolvedValue(newSvc),
          },
        };
        return fn(tx);
      });

      const result = await service.update('c1', 's1', { price: 2000 });

      expect(result.price).toBe(2000);
      expect(result.parentServiceId).toBe('s1');
    });

    it('preserves existing name/duration/prerequisites when price changes and they are not provided', async () => {
      const svc = makeService({ name: 'Original', durationMinutes: 30, prerequisites: 'Fasting' });
      prisma.service.findFirst.mockResolvedValue(svc);

      let createdWith: Record<string, unknown> = {};
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          service: {
            update: jest.fn().mockResolvedValue({}),
            create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
              createdWith = args.data;
              return Promise.resolve({ ...svc, ...args.data, id: 's2' });
            }),
          },
        };
        return fn(tx);
      });

      await service.update('c1', 's1', { price: 2000 });

      expect(createdWith.name).toBe('Original');
      expect(createdWith.durationMinutes).toBe(30);
      expect(createdWith.prerequisites).toBe('Fasting');
      expect(createdWith.parentServiceId).toBe('s1');
    });

    it('updates prerequisites to null when explicitly passed as null on price change', async () => {
      const svc = makeService({ prerequisites: 'Some prereq' });
      prisma.service.findFirst.mockResolvedValue(svc);

      let createdWith: Record<string, unknown> = {};
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          service: {
            update: jest.fn().mockResolvedValue({}),
            create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
              createdWith = args.data;
              return Promise.resolve({ ...svc, ...args.data, id: 's2' });
            }),
          },
        };
        return fn(tx);
      });

      await service.update('c1', 's1', { price: 2000, prerequisites: null });

      expect(createdWith.prerequisites).toBeNull();
    });
  });

  // ── archive ────────────────────────────────────────────────────────────────

  describe('archive', () => {
    it('throws NotFoundException when service does not exist', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.archive('c1', 's1')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when service is already archived', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService({ archivedAt: new Date() }));
      await expect(service.archive('c1', 's1')).rejects.toThrow(BadRequestException);
    });

    it('sets archivedAt for an active service', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService());
      prisma.service.update.mockResolvedValue(makeService({ archivedAt: new Date() }));

      await service.archive('c1', 's1');

      const callArgs = prisma.service.update.mock.calls[0][0];
      expect(callArgs.data.archivedAt).toBeInstanceOf(Date);
    });
  });

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('throws NotFoundException when not found', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.findOne('c1', 's1')).rejects.toThrow(NotFoundException);
    });

    it('returns the service when found', async () => {
      const svc = makeService();
      prisma.service.findFirst.mockResolvedValue(svc);
      const result = await service.findOne('c1', 's1');
      expect(result).toBe(svc);
    });
  });
});

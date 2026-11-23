package com.blinkchat.repository;

import com.blinkchat.model.Records.*;
import jakarta.persistence.*;
import java.util.*;
import org.springframework.stereotype.Repository;

@Repository
public class ChatRepository {

    @PersistenceContext
    private EntityManager em;

    public EntityManager entityManager() {
        return em;
    }

    public <T> T find(Class<T> type, String id) {
        return em.find(type, id);
    }

    public <T> T lock(Class<T> type, String id) {
        return em.find(type, id, LockModeType.PESSIMISTIC_WRITE);
    }

    public void save(Object value) {
        em.persist(value);
    }

    // Serialize room changes so concurrent joins and retries share one authoritative state.
    public Room room(String id) {
        return lock(Room.class, id);
    }

    public List<Membership> members(String room) {
        return em
            .createQuery("from Membership where roomId=:r and leftAt is null order by slot", Membership.class)
            .setParameter("r", room)
            .getResultList();
    }

    public List<Room> rooms(String guest) {
        return em
            .createQuery(
                "select r from Room r where r.id in (select m.roomId from Membership m where m.guestId=:g and m.leftAt is null) order by r.createdAt desc",
                Room.class
            )
            .setParameter("g", guest)
            .getResultList();
    }

    public List<MessageRecord> messages(String room) {
        return em
            .createQuery(
                "from MessageRecord where roomId=:r order by sequence",
                MessageRecord.class
            )
            .setParameter("r", room)
            .getResultList();
    }

    public List<MessageRecipient> recipients(String message) {
        return em
            .createQuery(
                "from MessageRecipient where messageId=:m order by guestId",
                MessageRecipient.class
            )
            .setParameter("m", message)
            .getResultList();
    }

    public MessageRecord operation(String room, String guest, String op) {
        return em
            .createQuery(
                "from MessageRecord where roomId=:r and senderId=:g and operationId=:o",
                MessageRecord.class
            )
            .setParameter("r", room)
            .setParameter("g", guest)
            .setParameter("o", op)
            .getResultStream()
            .findFirst()
            .orElse(null);
    }
}
